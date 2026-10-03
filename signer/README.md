# signer

승인·서명: plan.json을 받아 승인 후 이미지 digest에 cosign 서명하고, 서명 결과와 기록이 바뀌지 않았는지 확인 (승표)

## 흐름

```
plan.json ─→ [decision 확인] ─→ (needs_approval이면 approval.json 확인) ─→ cosign 서명 ─→ sign_result.json ─→ deploy
                                                         │                      ├─→ decisions.jsonl (kind: sign)
                                                         │                      └─→ 감사 로그 (해시 체인, 켤 때만)
                                                         ├─→ 서명 직후 자기 확인 (켤 때만)
                                                         └─→ 배포 증명서 in-toto attestation (켤 때만)

sign_result.json ─→ [npm run verify] ─→ 서명 주석과 하나라도 다르면 실패 (--attestation 이면 증명서 + Rego 정책까지)
감사 로그        ─→ [npm run audit:anchor] ─→ 끝 고정값 (지금 체인 끝에 서명, 다른 곳에 보관)
감사 로그        ─→ [npm run audit:verify] ─→ 끊긴 줄 번호 (--anchors 면 끝 자르기·다시 쓰기까지)
```

| decision | 처리 |
|---|---|
| `allow` | 바로 서명, approver는 `auto` |
| `needs_approval` | 요청자가 아닌 사람이 `approve`로 만든 approval.json이 있어야 서명 |
| `block` | 서명 안 함 |

- targets, failover_allowed는 plan 값 그대로 (서명 쪽에서 다시 판단 안 함)
- 승인 기록은 run_id, digest, plan_hash, plan 파일 해시에 묶임 → 승인 뒤 plan이나 이미지가 바뀌면 서명 안 함
- 승인 유효시간을 주면 오래된 승인도 서명 안 함 (`approval_expired`)
  - 지금 backend는 서명 직전에 승인 기록(approval.json)을 만들어서 만료가 거의 안 남. 당장은 `npm run approve` 뒤 시간이 지나서 `sign`하는 수동 CLI 흐름용
  - backend가 승인 버튼을 누른 시각으로 승인 기록을 만들면 그때부터 실제로 의미 있음
- Plan 스키마 검사를 못 하면 서명 안 함
- 거절이면 sign_result.json을 남기지 않음 (예전 결과가 있어도 지움, 인자 오류로 끝나도 지움)
- 서명에 sign_result의 targets·approver 등을 전부 주석으로 붙임 → 서명 뒤 sign_result를 고치면 verify 실패
- 사람 승인이면 승인 기록(누가, 언제) 해시까지 서명에 묶음
- 요청자·승인자 id는 대소문자를 구분하지 않고 같은 사람으로 봄 (`alice`가 요청하고 `Alice`가 승인해도 본인 승인으로 거절)
- 요청자 id 형식이 틀리면 서명 전에 멈춤 (`REQUESTER_INVALID`)
- cosign v3 이상만 씀. v2면 서명·확인 전에 멈춤 (`COSIGN_VERSION`)

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

# 서명 + 서명 직후 자기 확인 + 배포 증명서(시험 결과 포함) (공개키 지문 고정)
npm run sign -- ... --self-verify --attest --test-result test_result.json --pubkey-sha256 sha256:<지문>

# 서명 결과 확인 (누구나 공개키로)
npm run verify -- --result sign_result.json [--plan plan.json] [--approval approval.json] [--audit sign_audit.jsonl] \
  [--image-repo <저장소>] [--attestation [--policy policy/deploy.rego] [--test-result test_result.json]] \
  [--max-age 30] [--json] [--no-tlog]

# 공개키 지문 (고정값으로 쓸 값)
npm run fingerprint [-- --pub keys/cosign.pub]

# 감사 로그 끝 고정 (주기적으로, 결과 파일은 감사 로그와 다른 곳에도 보관)
npm run audit:anchor -- --audit sign_audit.jsonl --anchors sign_audit.anchors.jsonl --key ~/hibiscus-secrets/cosign.key

# 감사 로그 확인 (--anchors 면 끝 고정값과, --images 면 레지스트리 서명과 맞춰 봄)
npm run audit:verify -- --audit sign_audit.jsonl [--anchors sign_audit.anchors.jsonl] [--images [--strict-images] [--image-repo <저장소>]] [--no-tlog]

# 공격 시연 (로컬 레지스트리·임시 키, cosign·crane 필요)
bash scripts/attack-demo.sh
```

| 옵션 | 없을 때 | 설명 |
|---|---|---|
| `--image-repo` | `IMAGE_REPO` | 태그 없는 저장소 주소 (deploy coordinator와 같은 이름) |
| `--key` | `SIGNER_COSIGN_KEY` | 개인키 경로 또는 KMS 키 주소 (`gcpkms://...`). 비밀번호는 `COSIGN_PASSWORD` 환경변수로만 (KMS는 필요 없음) |
| `--no-tlog` | `SIGNER_NO_TLOG=1` | Rekor 없이 서명·확인. backend는 CLI 인자 안 바꾸고 환경변수만 켜면 됨 |
| `--audit` | `SIGNER_AUDIT_LOG` | 감사 로그 경로. 둘 다 없으면 안 씀 |
| `--approval-ttl` | `SIGNER_APPROVAL_TTL_MIN` | 승인 유효시간(분). 둘 다 없으면 시간은 안 봄 |
| `--pub` (verify) | `COSIGN_PUBLIC_KEY` → `keys/cosign.pub` | 공개키 경로 또는 KMS 키 주소. 키 교체 중이면 여러 번 (환경변수는 쉼표로) |
| `--pubkey-sha256` | `SIGNER_PUBKEY_SHA256` | 공개키 지문 고정 (여러 개 가능, 환경변수는 쉼표로). 확인에 쓰는 공개키가 이 목록에 없으면 멈춤 (`PUBKEY_MISMATCH`) |
| `--self-verify` (sign) | `SIGNER_SELF_VERIFY=1` | 서명 직후 공개키로 바로 다시 확인. 실패하면 sign_result 안 남김 |
| `--attest` (sign) | `SIGNER_ATTEST=1` | 배포 증명서도 이미지에 붙임. 못 붙이면 sign_result 안 남김 |
| `--test-result` | | sign: 시험 결과를 증명서에 넣음. verify `--attestation`: 이 시험 결과로 서명했는지 확인 |
| `--minimal-env` | `SIGNER_MINIMAL_ENV=1` | cosign 에 필요한 환경변수만 넘김 |
| | `SIGNER_STRICT_KEY_PERMS=1` | 개인키 파일을 다른 사용자도 읽을 수 있으면 서명 안 함 (없으면 경고만) |
| `--attestation` (verify) | | 배포 증명서도 확인. `--policy` 없으면 `policy/deploy.rego` |
| `--approval` (verify) | | 이 승인 기록으로 서명했는지까지 확인 |
| `--max-age` (verify) | `SIGNER_MAX_AGE_MIN` | 서명한 지 이 시간(분)이 지난 결과는 거부 (`expired`) |
| `--json` (verify) | | 결과를 JSON 한 줄로 (실행 오류도) |
| `--anchors` | `SIGNER_AUDIT_ANCHORS` | 감사 로그 끝 고정값 파일. anchor 는 여기에 추가, audit 는 이것과도 맞춰 봄. anchor 에서 없으면 `<감사 로그>.anchors.jsonl` |
| `--images` (audit) | | 레지스트리 서명과 맞춰 봄 |
| `--strict-images` (audit) | | `--images`와 같이. `audit_head` 없는 서명도 로그에 없는 서명으로 봄 (키 도용 감지) |

- 빈 환경변수는 없는 것으로 봄
- 종료 코드: 0 서명함·확인함 / 1 서명 거절·확인 실패 / 2 실행 오류 (인자, 파일, 키, 레지스트리 접근 등)

## 서명 주석

서명할 때 `cosign sign -a`로 붙이는 값. sign과 verify가 같은 함수(`src/annotations.ts`)로 만듦

| 주석 | 값 |
|---|---|
| `run_id`, `plan_hash` | plan 값 그대로 |
| `source_revision` | plan 값, 없으면 `none` (서명 뒤 sign_result에서 지워도 걸리게) |
| `targets` | 항목마다 `encodeURIComponent` 후 `+`로 연결 (예: `onprem+cloud_run`) |
| `failover_allowed` | `true` / `false` |
| `requester`, `approver` | 요청자, 승인자 (allow면 `auto`) |
| `approval_sha256` | 승인 기록(approval.json, 키 정렬 JSON) 해시. 자동 승인이면 `none` |
| `plan_sha256` | plan.json 전체(키 정렬 JSON) 해시. rules 등 나머지까지 묶음 |
| `signed_at` | 서명 시각, `encodeURIComponent`로 인코딩. sign_result의 signed_at만 고쳐서 `--max-age`를 피하지 못하게 |
| `audit_head` | 감사 로그를 켰을 때만. 서명 직전 체인 끝 hash |

- cosign `-a`는 값을 쉼표로 나눔 (`targets=onprem,cloud_run` → `unable to parse annotation: cloud_run`). 그래서 targets는 인코딩
- 이미지 주소는 cosign 인자에서 `--` 뒤에 넘김 (옵션처럼 생긴 값이 와도 옵션으로 안 읽힘)
- `cosign verify -a`는 넘긴 주석만 확인함 → 기존 배포 쪽 `-a run_id -a plan_hash` 확인은 그대로 통과
- 이 변경 전에 서명한 이미지는 새 주석이 없어서 `npm run verify` 실패. 다시 서명하면 됨
- requester·approver id가 레지스트리의 서명 정보에 보임 (GitHub id, Rekor에는 해시만)

## 서명 결과 확인 (`npm run verify`)

| 순서 | 확인 | 실패하면 |
|---|---|---|
| 1 | sign_result가 SignResult 형식 | 실행 오류 `SIGN_RESULT_INVALID` |
| 2 | dry-run 결과가 아님 | `dry_run` |
| 2-1 | `--max-age`면 서명한 지 그 시간 안 (미래 시각도 거부) | `expired` |
| 3 | `cosign:<저장소>@<digest>` 형식, digest가 sign_result와 같음 | `ref_invalid` |
| 4 | `--image-repo`와 같은 저장소 | `repo_mismatch` |
| 5 | `--plan`과 run_id·digest·plan_hash·source_revision·targets·failover_allowed가 같음 | `plan_mismatch` |
| 6 | `--approval`과 run_id·digest·plan_hash·requester·approver가 같음 (자동 승인 결과면 승인 기록을 주면 안 됨) | `approval_mismatch` |
| 7 | `--audit` 체인이 이어지고 이 실행의 signed 줄이 있음 | `audit_mismatch` |
| 8 | 위 주석 전부로 `cosign verify` | `signature_invalid` |
| 9 | `--attestation`이면 배포 증명서 서명·내용이 sign_result와 같음 (`--test-result`면 시험 결과 해시도) | `attestation_invalid` |
| 10 | `--attestation`이면 Rego 정책 통과 | `policy_denied` |

- 공개키를 못 읽거나(`KEY_UNAVAILABLE`) 레지스트리에 못 가면(`REGISTRY_UNAVAILABLE`) 검증 실패가 아니라 실행 오류(2)
- 알 수 없는 실행 실패(`VERIFY_FAILED`)나 잘못된 성공 출력(`VERIFY_OUTPUT_INVALID`)도 실행 오류(2)로 중단한다. 감사 검사에서 이를 빈 서명 목록으로 처리하지 않는다.
- 한 이미지에 서명이 여러 개면 "주석이 전부 맞는 서명이 하나라도 있으면" 통과 (cosign 규칙). 같은 이미지의 예전 정상 결과도 통과할 수 있어서, 최신인지는 run_id 확인이나 `--plan`, `--max-age`로
- `--json` 출력 (콘솔·backend가 그대로 읽는 용도)
  - 통과: `{"ok":true,"code":0,"run_id","digest","image","targets","failover_allowed","requester","approver","signed_at","checked":{...},"pubkeys":[...],"pubkey_pinned"}`
  - 실패: `{"ok":false,"code":1,"reason","detail"}` / 실행 오류: `{"ok":false,"code":2,"error","message"}`

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
  - signed 줄을 지우거나 거절로 바꾸면 → 레지스트리에 그 서명(`audit_head` 붙은)이 남아 있어서 `--images`에서 `unlogged_signature`
  - signed 줄의 `signature_ref`를 다른 이미지나 옵션처럼 생긴 값으로 바꾸면 → `ref_invalid`
- `--images`가 하는 일
  - 확인할 이미지: signed 줄의 이미지 + 모든 줄 digest × 아는 저장소(signed 줄 저장소, `--image-repo`)
  - 이미지마다 이 키로 확인되는 서명을 전부 받아서, signed 줄마다 내용·anchor가 맞는 서명이 있는지, `audit_head`가 붙은 서명이 전부 로그의 signed 줄과 맞는지 봄
  - `--strict-images`면 `audit_head` 없는 서명도 로그에 없는 서명(`unlogged_signature`)으로 봄. 키를 훔쳐 signer 밖에서 `cosign sign`으로 직접 서명한 것. 서명 자체는 진짜라 verify만으로는 못 막음
    - 감사 로그를 켜기 전에 서명한 이미지가 섞여 있으면 걸려서 opt-in
  - cosign v3 `verify`는 같은 키로 붙인 증명서(attest)도 서명 목록에 같이 돌려줌 → `critical.type`이 서명이 아닌 것은 뺌
  - 키 교체 중(`--pub` 여러 개)엔 이미지가 한 키로만 서명돼 있어도 됨. 어느 키로도 확인되는 서명이 없을 때만 `signature_invalid`
  - signed 줄이 하나도 없으면 저장소를 몰라서 `--image-repo` 필요 (없으면 실행 오류)
- 쓰기 전에 체인을 처음부터 끝까지 확인함. 중간 줄이라도 고쳐져 있으면 이어 쓰지 않고 서명도 안 함 (`AUDIT_INVALID`, 몇 번째 줄인지 나옴). 서명 뒤 감사 로그를 못 쓰면 sign_result도 안 남김
- plan·승인 기록 형식 오류, 잘못된 요청자처럼 결정 전에 멈춘 시도도 `kind: sign_error` 줄로 남김 (decisions.jsonl에는 안 씀)
- 여러 서명이 동시에 써도 갈라지지 않게 `<경로>.lock`으로 잠금 (5초 대기, 30초 넘은 잠금은 지움). cosign 서명 중에는 잠금 안 잡음
- backend에서 쓸 때는 실행마다 지워지지 않는 절대경로 (`SIGNER_AUDIT_LOG=/var/lib/hibiscus/sign_audit.jsonl` 등). decisions.jsonl은 실행 폴더와 같이 지워짐

### 끝 고정 (`npm run audit:anchor`)

체인은 중간을 고치면 잡지만, 끝을 잘라내거나 처음부터 다시 쓰면 남은 체인은 멀쩡해 보임. 그래서 지금 체인 끝(줄 수, hash)에 서명해서 따로 남겨 둠

```json
{"kind":"audit_anchor","seq":12,"head":"<12번째 줄 hash>","time":"2026-10-03T07:53:30Z","bundle":{ ...cosign sign-blob 결과... }}
```

- 서명하는 내용: 키 정렬 JSON `{"type":"hibiscus-audit-anchor/v1","seq","head","time"}`. `cosign sign-blob --bundle`로 서명, `verify-blob`으로 확인
- 체인이 깨진 로그는 고정하지 않음 (`AUDIT_INVALID`, 실행 오류)
- `audit:verify --anchors`가 고정값마다 확인하는 것
  - 서명이 믿는 공개키(`--pub`, 여러 개 가능)로 확인됨, 아니면 `anchor_signature_invalid`
  - 지금 로그에 그 줄이 있음, 없으면 끝이 잘린 것 `anchor_truncated`
  - 그 줄 hash가 고정값과 같음, 다르면 다시 쓴 것 `anchor_mismatch`
  - 고정값 파일이 비었거나 형식이 틀리면 `anchor_invalid`, 파일이 없으면 실행 오류 `ANCHORS_MISSING`
- 고정값 파일은 감사 로그와 다른 곳(다른 VM, 버킷, 팀 채널 등)에도 복사해 둬야 의미 있음. 둘 다 같이 지우면 못 잡음
- Rekor를 켜고(`--no-tlog` 없이) 고정하면 서명이 공개 투명성 로그에도 남아서, 그 시각에 로그가 거기까지 있었다는 걸 제3자가 확인 가능. 공개 로그라 hash·시각이 공개됨

### 감사 로그가 못 잡는 것

- 마지막 고정 뒤에 붙은 줄의 자르기·파일 통째 삭제. `--images`는 남은 로그에 있는 digest만 조회하므로, 삭제한 signed 줄의 digest가 다른 줄에도 없으면 찾지 못함. 별도로 보관한 sign_result가 있으면 `verify --audit`으로 해당 서명 줄의 누락 확인 가능
- 고정값 파일까지 같이 지우거나 잘라낸 경우 (그래서 다른 곳에 복사)
- 마지막 서명 뒤에 붙은 거절 줄은 체인과 끝 고정으로만 보호 (서명 anchor 범위 밖)
- 서명하는 동안 다른 실행이 붙인 줄은 그 서명의 anchor 범위 밖
- 레지스트리를 다 훑지는 않음. 로그에 한 번도 안 나온 이미지에 한 서명은 `--strict-images`로도 못 찾음
- 이미지를 레지스트리에서 지우면 그 signed 줄은 `signature_invalid`로 나옴 (변조와 구분 안 됨)
- 같은 이미지를 다른 감사 로그로 서명한 것(예: 로컬 시험)도 `unlogged_signature`로 나옴
- 감사 로그를 켜기 전에 한 서명, 이 변경 전에 한 서명(`source_revision` 주석 없음)은 다시 서명해야 맞춰 볼 수 있음

## 공개키 지문 고정

- 배포 쪽은 레포의 `keys/cosign.pub`로 서명을 확인함. main 보호가 없으면 누구든 이 파일을 자기 키로 바꿔서 자기가 서명한 이미지를 통과시킬 수 있음
- 지문을 레포 밖(VM 환경변수 등)에 고정해 두면, 공개키 파일이 바뀌었을 때 확인 전에 멈춤

```bash
npm run fingerprint            # sha256:2f049a775b1f1075c8c14ad13483b5d1ae411e32f7f89e2dc1b113b3a2d3dcfa  keys/cosign.pub
SIGNER_PUBKEY_SHA256=sha256:2f049a77... npm run verify -- --result sign_result.json
```

- 지문은 공개키(SubjectPublicKeyInfo DER)의 sha256. `openssl pkey -pubin -in keys/cosign.pub -outform DER | shasum -a 256`과 같음
- `--self-verify`와 같이 쓰면 서명 직후 확인도 고정한 공개키로만 함. 개인키가 공개키와 안 맞으면 배포 때가 아니라 서명 순간에 잡힘
- KMS 키 주소는 지문을 여기서 계산할 수 없어서 고정하면 멈춤 (`PUBKEY_PIN_UNSUPPORTED`)

### 키 교체

- 교체하는 동안 예전 키·새 키를 둘 다 믿음: `--pub old.pub --pub new.pub` (또는 `COSIGN_PUBLIC_KEY=old.pub,new.pub`), 지문도 둘 다 고정
- 서명·증명서·감사 로그 고정값은 둘 중 아무 키로나 확인되면 통과. 공개키를 못 읽거나 레지스트리 접근 실패 같은 설정 오류는 다른 키 결과로 숨기지 않음
- 증명서가 정책(Rego)에 걸리면 다른 키 결과와 상관없이 `policy_denied`
- 예전 키로 서명한 이미지가 다 빠지면 예전 키를 목록에서 뺌

## 서명 환경

- 개인키 파일 권한: 다른 사용자도 읽을 수 있으면(예: 644) 서명할 때 경고. `SIGNER_STRICT_KEY_PERMS=1`이면 서명 안 함 (`KEY_PERMISSIONS`, 실행 오류). KMS 키·Windows는 안 봄
- `--minimal-env` / `SIGNER_MINIMAL_ENV=1`: cosign 프로세스에 필요한 환경변수만 넘김. backend의 DB 비밀번호, GitHub 토큰 같은 다른 비밀값이 cosign으로 안 감
  - 넘기는 것: `PATH`, `HOME`, `TMPDIR`, 로케일, 프록시, 인증서 경로, `DOCKER_CONFIG`, `GOOGLE_APPLICATION_CREDENTIALS`, `COSIGN_*`, `SIGSTORE_*`, `REKOR_*`, `CLOUDSDK_*`, `GOOGLE_*`, `AWS_*`, `AZURE_*`, `VAULT_*` 등

## 배포 증명서 (in-toto attestation)

서명과 별도로, 이 이미지가 어떤 정책 결정·승인·감사 기록으로 서명됐는지를 **서명된 문서(in-toto Statement, DSSE)**로 이미지에 붙임. 배포 직전에 `cosign verify-attestation --policy`로 서명과 정책(Rego)을 같이 확인

- 종류(predicateType): `https://hibiscus.lth.so/attestations/deploy-decision/v1`
- 내용(`contracts/DeployAttestation.schema.json`): run_id, digest, source_revision, decision, targets, failover_allowed, plan_hash, plan_sha256, 걸린 규칙(matched_rules), requester, approver, approved_at, approval_sha256, audit_head, 시험 결과(test), signature_ref, signed_at, signer 버전
- 시험 결과(`--test-result`)를 주면 `test`에 넣음: test_result.json 해시, 통과 여부, 맞은 수/전체, 조건별(정상·재시작·교체) 결과
  - 루트 `contracts/TestResult.schema.json`으로 검사. 형식이 틀리면 `TEST_RESULT_INVALID`, run_id·digest가 서명할 plan과 다르면 `TEST_RESULT_MISMATCH` (둘 다 서명 안 함)
  - 시험 → 정책 → 승인 → 서명이 서명된 문서 하나로 이어짐
- 주석은 문자열 몇 개만 담을 수 있지만, 증명서는 결정 전체를 구조 그대로 담고 정책 엔진(OPA/Rego)으로 검사할 수 있음

`policy/deploy.rego`가 확인하는 것 (정책 판단을 다시 하지 않고, 서명된 결과가 승인 규칙을 벗어나지 않았는지만)

| 조건 | 내용 |
|---|---|
| 결정 | `allow` 또는 `needs_approval`만 (block은 서명 안 함) |
| 배포 위치 | 하나 이상, `onprem`·`cloud_run`만 |
| 자동 승인 | `allow`일 때만 approver `auto`, 승인 기록 없음(`none`) |
| 사람 승인 | `needs_approval`이면 승인자 ≠ 요청자(대소문자 무시), 승인자 `auto` 금지, 승인 기록 해시 있음 |

`policy/strict.rego`: 회사별로 바꿔 끼우는 엄격한 정책 예시. deploy.rego 조건에 더해서

| 조건 | 내용 |
|---|---|
| 시험 | 증명서에 시험 결과가 있고, 통과했고, 맞은 수 = 전체, 모든 조건에서 맞음 |
| 개인정보 | 개인정보 규칙(R4)이 걸린 앱은 `cloud_run` 금지, 장애 전환(failover)도 금지 |
| 승인 시각 | 사람 승인은 서명 1시간 안에 받은 것만 |

```bash
# 증명서까지 확인 (기본 정책)
npm run verify -- --result sign_result.json --attestation

# 시험 결과까지: 이 test_result 로 서명했는지 (다른 시험 결과로 바꿔치기 방지)
npm run verify -- --result sign_result.json --attestation --test-result test_result.json

# 회사마다 더 엄격한 정책을 따로 둘 수 있음
npm run verify -- --result sign_result.json --attestation --policy policy/strict.rego

# cosign 으로 직접
cosign verify-attestation --key signer/keys/cosign.pub --type https://hibiscus.lth.so/attestations/deploy-decision/v1 \
  --policy signer/policy/deploy.rego <저장소>@<digest>
```

- `--attest`를 켜면 서명할 때 cosign을 한 번 더 부름 (Rekor 없이면 `--no-tlog`와 같이)
- 같은 이미지에 증명서가 여러 개면 sign_result와 같은 것 하나만 있으면 통과. 정책은 cosign이 증명서마다 검사

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
  - backend-v2 `signature.verifier.ts`, onprem-agent `image-verifier.ts`는 아직 run_id·plan_hash만 확인함. 새 주석 확인은 배포 파트와 방식(`-a` 추가 / `npm run verify` 호출)을 맞춘 뒤 후속 PR로

## 형식

| 파일 | 내용 |
|---|---|
| `contracts/SignResult.schema.json` | sign_result.json |
| `contracts/SignLog.schema.json` | decisions.jsonl의 `kind: sign` 한 줄 |
| `contracts/Approval.schema.json` | approval.json (signer 안에서만) |
| `contracts/AuditLine.schema.json` | 감사 로그 한 줄 (signer 안에서만) |
| `contracts/DeployAttestation.schema.json` | 배포 증명서 predicate (signer 안에서만) |
| `contracts/AuditAnchor.schema.json` | 감사 로그 끝 고정값 한 줄 (signer 안에서만) |

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

## 공격 시연 (`scripts/attack-demo.sh`)

로컬 레지스트리(crane)와 임시 키로 정상 흐름을 한 번 돌린 뒤, 서명 뒤에 결과·기록·키를 바꾸는 공격을 차례로 해 보고 어디서 잡히는지 보여줌. 팀 키·GCP·공개 Rekor는 안 씀

```bash
cd signer && npm ci
bash scripts/attack-demo.sh            # DEMO_PORT=5055, DEMO_KEEP=1 이면 작업 폴더 남김
```

| 공격 | 잡는 곳 |
|---|---|
| block 결정 서명 요청, 승인자를 요청자 본인(대소문자만 바꿈)으로 | sign 거절 (`policy_block`, `self_approval`) |
| 다른 사용자도 읽을 수 있는 개인키 | sign 실행 오류 (`KEY_PERMISSIONS`) |
| 서명 뒤 targets에 cloud_run, approver, signed_at, plan 규칙 결과 바꾸기 | verify `signature_invalid` |
| 다른 이미지 digest, dry-run 결과 | verify `ref_invalid`, `dry_run` |
| 공격자 키로 서명 / 레포 공개키 바꿔치기 | verify `signature_invalid` / `PUBKEY_MISMATCH` |
| 팀 키를 훔쳐 signer 밖에서 직접 서명 | audit `--strict-images` `unlogged_signature` |
| 시험 실패 이미지 / 시험 결과 파일 바꿔치기 | verify `policy_denied` (strict.rego) / `attestation_invalid` |
| 감사 로그 한 줄 수정 / 끝 자르기 / 서명 줄 빼기 | audit `hash_mismatch` / `anchor_truncated` / verify `audit_mismatch` |

- 정상 흐름(서명, 증명서, 끝 고정, 전체 확인, 키 교체 중 확인)은 통과해야 함. 기대와 다르면 종료 코드 1
- 끝 자르기는 체인만 보면 통과하는 것(약점)도 같이 보여줌

## 테스트

```bash
npm test
npm run typecheck
bash scripts/attack-demo.sh   # 실제 cosign 으로 끝까지 (cosign·crane 필요)
```
