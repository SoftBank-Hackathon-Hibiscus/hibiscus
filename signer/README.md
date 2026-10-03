# signer

승인·서명: plan.json을 받아 승인 후 이미지 digest에 cosign 서명하고, 서명 결과와 기록이 바뀌지 않았는지 확인 (승표)

## 흐름

```
plan.json ─→ [decision 확인] ─→ (needs_approval이면 approval.json 확인) ─→ cosign 서명 ─→ sign_result.json ─→ deploy
                                                                                ├─→ decisions.jsonl (kind: sign)
                                                                                └─→ 감사 로그 (해시 체인, 켤 때만)

sign_result.json ─→ [npm run verify] ─→ 서명 주석과 하나라도 다르면 실패
감사 로그        ─→ [npm run audit:verify] ─→ 끊긴 줄 번호
```

| decision | 처리 |
|---|---|
| `allow` | 바로 서명, approver는 `auto` |
| `needs_approval` | 요청자가 아닌 사람이 `approve`로 만든 approval.json이 있어야 서명 |
| `block` | 서명 안 함 |

- targets, failover_allowed는 plan 값 그대로 (서명 쪽에서 다시 판단 안 함)
- 승인 기록은 run_id, digest, plan_hash, plan 파일 해시에 묶임 → 승인 뒤 plan이나 이미지가 바뀌면 서명 안 함
- 승인 유효시간을 주면 오래된 승인도 서명 안 함 (`approval_expired`)
- Plan 스키마 검사를 못 하면 서명 안 함
- 거절이면 sign_result.json을 남기지 않음 (예전 결과가 있어도 지움, 인자 오류로 끝나도 지움)
- 서명에 sign_result의 targets·approver 등을 전부 주석으로 붙임 → 서명 뒤 sign_result를 고치면 verify 실패

### 누가 요청하고 승인했는지는 signer가 확인하지 않음

- `--requester`, `--approver`에 들어온 id를 그대로 믿음. 로그인이나 GitHub 인증은 signer 밖의 일
- 인증된 사람 id를 넘기는 건 부르는 쪽(backend) 책임. 예: webhook의 push 작성자 → requester, 로그인한 승인 화면 사용자 → approver
- signer가 막는 건 본인 승인, 승인 뒤 plan·이미지 바꿔치기, 오래된 승인, 서명 뒤 결과 바꿔치기까지

## 사용법

```bash
cd signer && npm ci

# needs_approval일 때: 요청자가 아닌 사람이 승인 기록 만들기
npm run approve -- --plan plan.json --requester <요청자> --approver <승인자> --out approval.json

# 서명 (allow면 --approval 없이)
COSIGN_PASSWORD="$(cat ~/hibiscus-secrets/cosign.password)" \
npm run sign -- --plan plan.json --requester <요청자> [--approval approval.json] \
  --image-repo <저장소> --key ~/hibiscus-secrets/cosign.key \
  --out sign_result.json --log decisions.jsonl \
  [--audit /var/lib/hibiscus/sign_audit.jsonl] [--approval-ttl 15]

# Rekor 장애 시: Rekor에 안 올리고 서명
npm run sign -- ... --key ~/hibiscus-secrets/cosign.key --no-tlog

# cosign 없이 연결만 확인 (signature_ref가 dry-run:...)
npm run sign -- --plan plan.json --requester <요청자> --image-repo <저장소> --dry-run

# 서명 결과 확인 (누구나 공개키로)
npm run verify -- --result sign_result.json [--plan plan.json] [--audit sign_audit.jsonl] [--image-repo <저장소>] [--no-tlog]

# 감사 로그 확인 (--images 면 이미지 서명까지)
npm run audit:verify -- --audit sign_audit.jsonl [--images --no-tlog]
```

| 옵션 | 없을 때 | 설명 |
|---|---|---|
| `--image-repo` | `IMAGE_REPO` | 태그 없는 저장소 주소 (deploy coordinator와 같은 이름) |
| `--key` | `SIGNER_COSIGN_KEY` | 개인키 경로 또는 KMS 키 주소 (`gcpkms://...`). 비밀번호는 `COSIGN_PASSWORD` 환경변수로만 (KMS는 필요 없음) |
| `--no-tlog` | `SIGNER_NO_TLOG=1` | Rekor 없이 서명·확인. backend는 CLI 인자 안 바꾸고 환경변수만 켜면 됨 |
| `--audit` | `SIGNER_AUDIT_LOG` | 감사 로그 경로. 둘 다 없으면 안 씀 |
| `--approval-ttl` | `SIGNER_APPROVAL_TTL_MIN` | 승인 유효시간(분). 둘 다 없으면 시간은 안 봄 |
| `--pub` (verify) | `COSIGN_PUBLIC_KEY` → `keys/cosign.pub` | 공개키 경로 또는 KMS 키 주소 |

- 빈 환경변수는 없는 것으로 봄
- 종료 코드: 0 서명함·확인함 / 1 서명 거절·확인 실패 / 2 실행 오류 (인자, 파일, 키, 레지스트리 접근 등)

## 서명 주석

서명할 때 `cosign sign -a`로 붙이는 값. sign과 verify가 같은 함수(`src/annotations.ts`)로 만듦

| 주석 | 값 |
|---|---|
| `run_id`, `plan_hash` | plan 값 그대로 |
| `source_revision` | plan에 있을 때만 |
| `targets` | 항목마다 `encodeURIComponent` 후 `+`로 연결 (예: `onprem+cloud_run`) |
| `failover_allowed` | `true` / `false` |
| `requester`, `approver` | 요청자, 승인자 (allow면 `auto`) |
| `plan_sha256` | plan.json 전체(키 정렬 JSON) 해시. rules 등 나머지까지 묶음 |
| `audit_head` | 감사 로그를 켰을 때만. 서명 직전 체인 끝 hash |

- cosign `-a`는 값을 쉼표로 나눔 (`targets=onprem,cloud_run` → `unable to parse annotation: cloud_run`). 그래서 targets는 인코딩
- `cosign verify -a`는 넘긴 주석만 확인함 → 기존 배포 쪽 `-a run_id -a plan_hash` 확인은 그대로 통과
- 이 변경 전에 서명한 이미지는 새 주석이 없어서 `npm run verify` 실패. 다시 서명하면 됨
- requester·approver id가 레지스트리의 서명 정보에 보임 (GitHub id, Rekor에는 해시만)

## 서명 결과 확인 (`npm run verify`)

| 순서 | 확인 | 실패하면 |
|---|---|---|
| 1 | sign_result가 SignResult 형식 | 실행 오류 `SIGN_RESULT_INVALID` |
| 2 | dry-run 결과가 아님 | `dry_run` |
| 3 | `cosign:<저장소>@<digest>` 형식, digest가 sign_result와 같음 | `ref_invalid` |
| 4 | `--image-repo`와 같은 저장소 | `repo_mismatch` |
| 5 | `--plan`과 run_id·digest·plan_hash·source_revision·targets·failover_allowed가 같음 | `plan_mismatch` |
| 6 | `--audit` 체인이 이어지고 이 실행의 signed 줄이 있음 | `audit_mismatch` |
| 7 | 위 주석 전부로 `cosign verify` | `signature_invalid` |

- 공개키를 못 읽거나(`KEY_UNAVAILABLE`) 레지스트리에 못 가면(`REGISTRY_UNAVAILABLE`) 검증 실패가 아니라 실행 오류(2)
- 한 이미지에 서명이 여러 개면 "주석이 전부 맞는 서명이 하나라도 있으면" 통과 (cosign 규칙). 같은 이미지의 예전 정상 결과도 통과할 수 있어서, 최신인지는 run_id 확인이나 `--plan`으로

## 감사 로그 (해시 체인)

```json
{"seq":2,"prev_hash":"<앞 줄 hash>","entry":{ ...kind: sign 한 줄... },"anchor":"<서명 직전 체인 끝>","hash":"<이 줄 hash>"}
```

- 서명 결정(거절·서명 실패·서명)마다 한 줄. `entry`는 decisions.jsonl에 쓰는 줄과 같음
- `hash = sha256(키 정렬 JSON {seq, prev_hash, entry, anchor})`, 첫 줄 `prev_hash`는 0 × 64
- signed 줄의 `anchor` = 서명 직전 체인 끝 = 이미지 서명의 `audit_head` 주석
  - 한 줄 고치면 → `hash_mismatch`
  - 줄 삭제·순서 바꿈 → `seq_gap` / `prev_mismatch`
  - 체인을 통째로 다시 계산하면 → `anchor_invalid`, anchor까지 맞추면 이미지 서명과 안 맞아서 `--images`·`verify --audit`에서 `signature_invalid`
- 마지막 줄이 깨져 있으면 이어 쓰지 않고 서명도 안 함 (`AUDIT_INVALID`). 서명 뒤 감사 로그를 못 쓰면 sign_result도 안 남김
- 여러 서명이 동시에 써도 갈라지지 않게 `<경로>.lock`으로 잠금 (5초 대기, 30초 넘은 잠금은 지움). cosign 서명 중에는 잠금 안 잡음
- backend에서 쓸 때는 실행마다 지워지지 않는 절대경로 (`SIGNER_AUDIT_LOG=/var/lib/hibiscus/sign_audit.jsonl` 등). decisions.jsonl은 실행 폴더와 같이 지워짐

### 감사 로그가 못 잡는 것

- 파일 끝 자르기·파일 통째 삭제 (특정 실행의 줄이 사라진 건 `verify --audit`으로 잡음)
- 마지막 서명 뒤에 붙은 거절 줄은 체인으로만 보호 (anchor 범위 밖)
- 서명하는 동안 다른 실행이 붙인 줄은 그 서명의 anchor 범위 밖

## 배포 쪽 서명 확인

```bash
# 기존 방식 (backend-v2, onprem-agent): run_id·plan_hash만
cosign verify --key signer/keys/cosign.pub -a run_id=<run_id> -a plan_hash=<plan_hash> <저장소>@<digest>

# sign_result 전체까지: npm run verify 를 부르거나 주석을 더 붙임
cosign verify --key signer/keys/cosign.pub -a run_id=... -a plan_hash=... \
  -a targets=onprem+cloud_run -a failover_allowed=false -a approver=<승인자> <저장소>@<digest>
```

- `--no-tlog`로 서명한 이미지는 `--insecure-ignore-tlog=true`를 붙여야 통과 (안 붙이면 실패)
- signature_ref가 `dry-run:`으로 시작하면 실제 서명이 아니라서 배포하면 안 됨 (`npm run verify`도 거부)
- 배포 쪽이 `run_id`·`plan_hash`만 보면 서명 뒤 targets 바꿔치기는 못 잡음 → 위처럼 주석을 더 붙이거나 `npm run verify` 사용

## 형식

| 파일 | 내용 |
|---|---|
| `contracts/SignResult.schema.json` | sign_result.json |
| `contracts/SignLog.schema.json` | decisions.jsonl의 `kind: sign` 한 줄 |
| `contracts/Approval.schema.json` | approval.json (signer 안에서만) |
| `contracts/AuditLine.schema.json` | 감사 로그 한 줄 (signer 안에서만) |

- `npm run contracts`로 `src/schema.ts`에서 생성 (손으로 고치지 않음)
- SignResult, SignLog는 루트 `contracts/`에도 같은 파일이 있음. 바꾸면 같은 PR에서 루트에도 복사 (테스트가 확인)
- plan 검사는 루트 `contracts/Plan.schema.json` 사용 (`--plan-schema`로 바꿀 수 있음)
- plan_hash는 plan.json 값 그대로 (접두어 없이 64자), digest는 `sha256:` + 64자

## 키

- 개인키·비밀번호는 레포에 없음 (승표 보관, backend는 GCP Secret Manager)
- 공개키: `keys/cosign.pub`
- Cloud KMS로 바꿀 때 (코드는 준비됨, KMS 키는 아직 안 만듦)

```bash
# 키 만들기 (EC P-256, 개인키는 KMS 밖으로 안 나옴)
cosign generate-key-pair --kms gcpkms://projects/<프로젝트>/locations/<위치>/keyRings/<키링>/cryptoKeys/<키>
cosign public-key --key gcpkms://... > keys/cosign.pub     # 공개키 교체 (배포 쪽도 같이)

# 서명: 비밀번호 대신 서비스 계정 권한 (roles/cloudkms.signerVerifier)
SIGNER_COSIGN_KEY=gcpkms://... npm run sign -- ...
```

- 키를 바꾸면 `keys/cosign.pub`와 배포 쪽 공개키를 같이 바꿔야 함 (예전 키로 서명한 이미지는 새 공개키로 실패)

## 테스트

```bash
npm test
npm run typecheck
```
