# signer

승인·서명: plan.json을 받아 승인 후 이미지 digest에 cosign 서명 (승표)

## 흐름

```
plan.json ─→ [decision 확인] ─→ (needs_approval이면 approval.json 확인) ─→ cosign 서명 ─→ sign_result.json ─→ deploy
                                                                                └─→ decisions.jsonl (kind: sign)
```

| decision | 처리 |
|---|---|
| `allow` | 바로 서명, approver는 `auto` |
| `needs_approval` | 요청자가 아닌 사람이 `approve`로 만든 approval.json이 있어야 서명 |
| `block` | 서명 안 함 |

- targets, failover_allowed는 plan 값 그대로 (서명 쪽에서 다시 판단 안 함)
- 승인 기록은 run_id, digest, plan_hash, plan 파일 해시에 묶임 → 승인 뒤 plan이나 이미지가 바뀌면 서명 안 함
- Plan 스키마 검사를 못 하면 서명 안 함
- 거절이면 sign_result.json을 남기지 않음 (예전 결과가 있어도 지움)

### 누가 요청하고 승인했는지는 signer가 확인하지 않음

- `--requester`, `--approver`에 들어온 id를 그대로 믿음. 로그인이나 GitHub 인증은 signer 밖의 일
- 인증된 사람 id를 넘기는 건 부르는 쪽(backend) 책임. 예: webhook의 push 작성자 → requester, 로그인한 승인 화면 사용자 → approver
- signer가 막는 건 본인 승인, 승인 뒤 plan·이미지 바꿔치기까지

## 사용법

```bash
cd signer && npm ci

# needs_approval일 때: 요청자가 아닌 사람이 승인 기록 만들기
npm run approve -- --plan plan.json --requester <요청자> --approver <승인자> --out approval.json

# 서명 (allow면 --approval 없이)
COSIGN_PASSWORD="$(cat ~/hibiscus-secrets/cosign.password)" \
npm run sign -- --plan plan.json --requester <요청자> [--approval approval.json] \
  --image-repo <저장소> --key ~/hibiscus-secrets/cosign.key \
  --out sign_result.json --log decisions.jsonl

# Rekor 장애 시: Rekor에 안 올리고 서명
npm run sign -- ... --key ~/hibiscus-secrets/cosign.key --no-tlog

# cosign 없이 연결만 확인 (signature_ref가 dry-run:...)
npm run sign -- --plan plan.json --requester <요청자> --image-repo <저장소> --dry-run
```

- `--image-repo`: 태그 없는 저장소 주소. 없으면 `IMAGE_REPO` 환경변수 (deploy coordinator와 같은 이름)
- `--key`: 없으면 `SIGNER_COSIGN_KEY` 환경변수. 비밀번호는 `COSIGN_PASSWORD` 환경변수로만
- 종료 코드: 0 서명함 / 1 서명 거절 / 2 실행 오류

## 배포 쪽 서명 확인

```bash
cosign verify --key signer/keys/cosign.pub -a plan_hash=<sign_result.plan_hash> <저장소>@<digest>
```

- 서명에 run_id, plan_hash, source_revision 주석이 붙어 있어서 "이 plan으로 서명된 이미지"인지까지 확인 가능
- `--no-tlog`로 서명한 이미지는 위 명령에 `--insecure-ignore-tlog=true`를 붙여야 통과 (안 붙이면 실패)
- signature_ref가 `dry-run:`으로 시작하면 실제 서명이 아니라서 배포하면 안 됨

## 형식

| 파일 | 내용 |
|---|---|
| `contracts/SignResult.schema.json` | sign_result.json |
| `contracts/SignLog.schema.json` | decisions.jsonl의 `kind: sign` 한 줄 |
| `contracts/Approval.schema.json` | approval.json |

- `npm run contracts`로 `src/schema.ts`에서 생성 (손으로 고치지 않음)
- SignResult, SignLog는 루트 `contracts/`에도 같은 파일이 있음. 바꾸면 같은 PR에서 루트에도 복사 (테스트가 확인)
- plan 검사는 `policy/contracts/Plan.schema.json` 사용 (`--plan-schema`로 바꿀 수 있음)
- plan_hash는 plan.json 값 그대로 (접두어 없이 64자), digest는 `sha256:` + 64자

## 키

- 개인키·비밀번호는 레포에 없음 (승표 보관)
- 공개키: `keys/cosign.pub`
- 이후 Cloud KMS 키로 바꿀 예정

## 테스트

```bash
npm test
npm run typecheck
```
