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
감사 로그        ─→ [npm run audit:verify] ─→ 끊긴 줄 번호 (--anchors 면 끝 자르기·다시 쓰기까지, --images --sweep 이면 레지스트리 전체)
문제 생긴 이미지 ─→ [npm run revoke] ─→ 철회 줄 (그 서명은 verify --audit 에서 revoked)
실제 배포 상태   ─→ [npm run reconcile] ─→ 떠 있는 이미지·위치가 서명된 그대로인지
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

### 누가 요청하고 승인했는지는 signer가 확인하지 않음 (승인자 서명을 켜면 승인자는 확인)

- `--requester`, `--approver`에 들어온 id를 그대로 믿음. 로그인이나 GitHub 인증은 signer 밖의 일
- 승인자 서명(`--approvers`)을 켜면 승인 기록은 승인자 본인 SSH 키로 서명한 것만 받음 (아래 "승인자 SSH 서명")
- 인증된 사람 id를 넘기는 건 부르는 쪽(backend) 책임. 예: webhook의 push 작성자 → requester, 로그인한 승인 화면 사용자 → approver
- signer가 막는 건 본인 승인, 승인 뒤 plan·이미지 바꿔치기, 오래된 승인, 서명 뒤 결과 바꿔치기까지

## 사용법

```bash
cd signer && npm ci

# needs_approval일 때: 요청자가 아닌 사람이 승인 기록 만들기 (--ssh-key 면 승인자 SSH 키로 서명해서 approval.json.sig 도)
npm run approve -- --plan plan.json --requester <요청자> --approver <승인자> --out approval.json [--ssh-key ~/.ssh/id_ed25519]

# 서명 (allow면 --approval 없이)
COSIGN_PASSWORD="$(cat ~/hibiscus-secrets/cosign.password)" \
npm run sign -- --plan plan.json --requester <요청자> [--approval approval.json] \
  --image-repo <저장소> --key ~/hibiscus-secrets/cosign.key \
  --out sign_result.json --log decisions.jsonl \
  [--audit /var/lib/hibiscus/sign_audit.jsonl] [--approval-ttl 15] [--approvers allowed_signers]

# Rekor 장애 시: Rekor에 안 올리고 서명
npm run sign -- ... --key ~/hibiscus-secrets/cosign.key --no-tlog

# cosign 없이 연결만 확인 (signature_ref가 dry-run:...)
npm run sign -- --plan plan.json --requester <요청자> --image-repo <저장소> --dry-run

# 서명 + 서명 직후 자기 확인 + 배포 증명서(시험 결과 포함) (공개키 지문 고정)
npm run sign -- ... --self-verify --attest --test-result test_result.json --pubkey-sha256 sha256:<지문>

# 서명 결과 확인 (누구나 공개키로)
npm run verify -- --result sign_result.json [--plan plan.json] [--approval approval.json] [--audit sign_audit.jsonl [--anchors sign_audit.anchors.jsonl] [--latest]] \
  [--image-repo <저장소>] [--attestation [--policy policy/deploy.rego] [--policy-sha256 sha256:<지문>] [--test-result test_result.json]] \
  [--max-age 30] [--json] [--no-tlog]

# 공개키 지문, 정책 파일 지문 (고정값으로 쓸 값)
npm run fingerprint [-- --pub keys/cosign.pub]
npm run fingerprint -- --policy policy/strict.rego

# 서명 철회 (이미지 전체, 또는 --run-id 로 그 실행만)
npm run revoke -- --audit sign_audit.jsonl --digest sha256:<digest> [--run-id <run_id>] --reason vulnerability --by <철회한 사람> [--note "CVE-…"] \
  [--anchors sign_audit.anchors.jsonl --key ~/hibiscus-secrets/cosign.key]

# 실제 배포 상태 대조 (관측 파일은 감사자가 만듦)
npm run reconcile -- --observed observed.jsonl --audit sign_audit.jsonl [--anchors sign_audit.anchors.jsonl] [--json]

# 감사 로그 끝 고정 (주기적으로, 결과 파일은 감사 로그와 다른 곳에도 보관)
npm run audit:anchor -- --audit sign_audit.jsonl --anchors sign_audit.anchors.jsonl --key ~/hibiscus-secrets/cosign.key

# 감사 로그 확인 (--anchors 면 끝 고정값과, --images 면 레지스트리 서명과 맞춰 봄)
npm run audit:verify -- --audit sign_audit.jsonl [--anchors sign_audit.anchors.jsonl] \
  [--images [--strict-images] [--sweep] [--digests-file digests.txt] [--image-repo <저장소>]] [--json] [--no-tlog]

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
| `--test-result` | | sign: 시험 결과를 증명서에 넣음 (`--attest` 없이 주면 `ARG_INVALID`). verify `--attestation`: 이 시험 결과로 서명했는지 확인 |
| `--minimal-env` | `SIGNER_MINIMAL_ENV=1` | cosign 에 필요한 환경변수만 넘김 |
| | `SIGNER_STRICT_KEY_PERMS=1` | 개인키 파일을 다른 사용자도 읽을 수 있으면 서명 안 함 (없으면 경고만) |
| `--attestation` (verify) | | 배포 증명서도 확인. `--policy` 없으면 `policy/deploy.rego` (`--policy`만 주고 `--attestation`이 없으면 `ARG_INVALID`) |
| `--policy-sha256` (verify) | `SIGNER_POLICY_SHA256` | Rego 정책 파일 지문 고정 (여러 개 가능). 정책 파일이 이 목록에 없으면 멈춤 (`POLICY_PIN_MISMATCH`) |
| `--approval` (verify) | | 이 승인 기록으로 서명했는지까지 확인 |
| `--ssh-key` (approve) | | 승인 기록에 승인자 SSH 키로 서명 (`<승인 기록>.sig`) |
| `--approvers` (sign, verify) | `SIGNER_APPROVERS` (승인 기록을 줄 때만) | 승인자 명부(ssh `allowed_signers`). 사람 승인은 명부의 그 id 키로 서명한 승인 기록만 |
| `--approvers-sha256` | `SIGNER_APPROVERS_SHA256` | 승인자 명부 지문 고정 (`APPROVERS_PIN_MISMATCH`) |
| `--approval-sig` | | 승인 서명 파일. 없으면 `<승인 기록>.sig` |
| `--max-age` (verify) | `SIGNER_MAX_AGE_MIN` | 서명한 지 이 시간(분)이 지난 결과는 거부 (`expired`) |
| `--json` (verify, audit, reconcile) | | 결과를 JSON 한 줄로 (실행 오류도) |
| `--latest` (verify) | `SIGNER_VERIFY_LATEST=1` | `--audit`와 같이. 뒤에 더 새로 서명한 결과가 있거나 같은 이미지가 block 됐으면 거부 (`superseded`) |
| `--anchors` | `SIGNER_AUDIT_ANCHORS` | 감사 로그 끝 고정값 파일. anchor 는 여기에 추가, audit·reconcile·`verify --audit`는 이것과도 맞춰 봄. anchor 에서 없으면 `<감사 로그>.anchors.jsonl` |
| `--images` (audit) | | 레지스트리 서명과 맞춰 봄 |
| `--strict-images` (audit) | | `--images`와 같이. `audit_head` 없는 서명도 로그에 없는 서명으로 봄 (키 도용 감지) |
| `--sweep` (audit) | `SIGNER_AUDIT_SWEEP=1` | `--images`와 같이. 저장소 태그를 crane 으로 전부 훑어서 로그에 없던 이미지의 서명도 봄 |
| `--sweep-max` (audit) | | 저장소당 태그 한도 (기본 1000). 넘으면 멈춤 (`SWEEP_TRUNCATED`) |
| `--digests-file` (audit) | | 태그 없는 이미지 digest 목록 (`sha256:<hex>` 또는 `<저장소>@sha256:<hex>`, 한 줄에 하나) |
| `--observed` (reconcile) | | 실제 배포 상태 관측 파일 (`contracts/Observed.schema.json`) |
| `--digest`, `--run-id`, `--reason`, `--by`, `--note` (revoke) | | 철회할 이미지·실행, 이유(`vulnerability`/`policy_changed`/`key_compromise`/`mistake`), 철회한 사람, 메모 |

- 빈 환경변수는 없는 것으로 봄
- 화면에 찍는 문자열의 제어 문자(터미널 escape, 방향 바꾸는 유니코드)는 `\uXXXX`로 바꿔 찍음. sign_result·감사 로그처럼 남이 쓴 값으로 화면을 속이지 못하게
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
| `approval_key` | 승인자 서명을 확인했을 때만. 승인 기록에 서명한 SSH 키 지문 (`SHA256:…`, 인코딩) |
| `plan_sha256` | plan.json 전체(키 정렬 JSON) 해시. rules 등 나머지까지 묶음 |
| `signed_at` | 서명 시각, `encodeURIComponent`로 인코딩. sign_result의 signed_at만 고쳐서 `--max-age`를 피하지 못하게 |
| `audit_head` | 감사 로그를 켰을 때만. 서명 직전 체인 끝 hash |
| `image_repo` | 서명한 저장소, `encodeURIComponent`로 인코딩. 이미지와 서명을 다른 저장소로 복사해 쓰지 못하게 |

- cosign `-a`는 값을 쉼표로 나눔 (`targets=onprem,cloud_run` → `unable to parse annotation: cloud_run`). 그래서 targets는 인코딩
- 이미지 주소는 cosign 인자에서 `--` 뒤에 넘김 (옵션처럼 생긴 값이 와도 옵션으로 안 읽힘)
- `cosign verify -a`는 넘긴 주석만 확인함 → 기존 배포 쪽 `-a run_id -a plan_hash` 확인은 그대로 통과
- 이 변경 전에 서명한 이미지는 새 주석이 없어서 `npm run verify` 실패. 다시 서명하면 됨
- requester·approver id가 레지스트리의 서명 정보에 보임 (GitHub id, Rekor에는 해시만)

## 서명 결과 확인 (`npm run verify`)

| 순서 | 확인 | 실패하면 |
|---|---|---|
| 1 | sign_result가 SignResult 형식 | 실행 오류 `SIGN_RESULT_INVALID` |
| 2 | `--max-age`면 서명한 지 그 시간 안 (미래 시각도 거부) | `expired` |
| 3 | dry-run 결과가 아님 | `dry_run` |
| 4 | `cosign:<저장소>@<digest>` 형식, digest가 sign_result와 같음 | `ref_invalid` |
| 5 | `--image-repo`와 같은 저장소 | `repo_mismatch` |
| 6 | `--plan`과 run_id·digest·plan_hash·source_revision·targets·failover_allowed가 같음 | `plan_mismatch` |
| 7 | `--approval`과 run_id·digest·plan_hash·requester·approver가 같음 (자동 승인 결과면 승인 기록을 주면 안 됨) | `approval_mismatch` |
| 8 | `--audit` 체인이 이어지고(`--anchors`면 끝 고정값과도 같고), 이 실행의 signed 줄이 있고, 취소된 서명이 아니고, 기록한 주석과 sign_result가 같음 | `audit_mismatch` |
| 9 | `--audit`이면 철회되지 않음 | `revoked` |
| 10 | `--latest`면 뒤에 더 새 서명·같은 이미지의 block 결정이 없음 | `superseded` |
| 11 | 위 주석 전부로 `cosign verify` (`--audit`이면 기록한 주석 그대로). 저장소만 다른 서명이 있으면 | `signature_invalid` / `repo_mismatch` |
| 12 | `--attestation`이면 배포 증명서 서명·내용이 sign_result와 같음 (`--test-result`면 시험 결과 해시도) | `attestation_invalid` |
| 13 | `--attestation`이면 Rego 정책 통과 | `policy_denied` |

- 공개키를 못 읽거나(`KEY_UNAVAILABLE`) 레지스트리에 못 가면(`REGISTRY_UNAVAILABLE`) 검증 실패가 아니라 실행 오류(2)
- 정책 파일이 없거나(`POLICY_MISSING`) 문법 오류로 못 불러오면(`POLICY_INVALID`) 정책 위반이 아니라 실행 오류(2). cosign 은 둘 다 정책 위반과 같은 문구로 끝나서 앞 줄들까지 봄
- 알 수 없는 실행 실패(`VERIFY_FAILED`)나 잘못된 성공 출력(`VERIFY_OUTPUT_INVALID`)도 실행 오류(2)로 중단한다. 감사 검사에서 이를 빈 서명 목록으로 처리하지 않는다.
- 한 이미지에 서명이 여러 개면 "주석이 전부 맞는 서명이 하나라도 있으면" 통과 (cosign 규칙). 같은 이미지의 예전 정상 결과도 통과할 수 있어서, 최신인지는 `--audit --latest`, `--plan`, `--max-age`로
- 키를 가진 사람이 정상 서명 주석을 복사해 targets 만 바꾼 쌍둥이 서명을 붙이면 `--audit` 없는 verify 는 통과함. `--audit`이면 감사 로그에 기록한 주석과 비교해서 걸림
- `--audit`만 주면 감사 로그 파일을 고칠 수 있는 사람이 끝의 철회·취소·block 줄을 잘라내 `revoked`·취소·`--latest` 검사를 피할 수 있음. 배포 직전 확인은 `--anchors`도 같이 (`SIGNER_AUDIT_ANCHORS`는 `--audit`가 있을 때만 씀)
- `--json` 출력 (콘솔·backend가 그대로 읽는 용도)
  - 통과: `{"ok":true,"code":0,"run_id","digest","image","targets","failover_allowed","requester","approver","signed_at","checked":{...},"pubkeys":[...],"pubkey_pinned"}`
  - 실패: `{"ok":false,"code":1,"reason","detail"}` / 실행 오류: `{"ok":false,"code":2,"error","message"}`

## 감사 로그 (해시 체인)

```json
{"seq":2,"prev_hash":"<앞 줄 hash>","entry":{ ...kind: sign 한 줄... },"anchor":"<서명 직전 체인 끝>","annotations":{ ...서명에 붙인 주석 전체... },"hash":"<이 줄 hash>"}
```

- 서명 결정(거절·서명 실패·서명)마다 한 줄. `entry`는 decisions.jsonl에 쓰는 줄과 같음
- `hash = sha256(키 정렬 JSON {seq, prev_hash, entry, anchor, annotations, cancels})`, 첫 줄 `prev_hash`는 0 × 64. 없는 필드는 빠져서 예전 줄 hash 는 그대로
- signed 줄의 `annotations` = 이미지 서명에 실제로 붙인 주석 전체
  - 줄 내용·anchor 와 다르거나, 앞 줄부터 기록했는데 이 줄에만 없으면(지운 흔적) `annotations_invalid`
  - `--images`·`verify --audit`·`reconcile`은 이 기록과 정확히 같은 서명만 인정 → 주석만 바꾼 쌍둥이 서명은 `twin_signature`
  - 쌍둥이에서 `audit_head`까지 빼면 signer 밖 서명과 같아져서 `--strict-images`일 때만 `unlogged_signature` (기본 모드는 통과). 이때도 `verify --audit`는 `audit_mismatch`, reconcile 은 `target_not_signed`
- 서명은 됐는데 뒤 단계(자기 확인·증명서)가 실패하면, signed 줄을 먼저 남기고 그 줄을 `cancels`로 가리키는 거절 줄을 붙임
  - 레지스트리에 남은 서명이 기록에 있어서 `--images`가 계속 `unlogged_signature`를 내지 않음
  - 그 서명으로 sign_result 를 다시 만들어도 `verify --audit`에서 `audit_mismatch` (취소된 서명)
  - `cancels`는 앞의 같은 실행 signed 줄을 한 번만, sign_failed 거절 줄에서만. 어기면 `cancel_invalid`
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
  - cosign v3 `verify`는 같은 키로 붙인 증명서(attest)도 서명 목록에 같이 돌려줌 → `critical.type`이 서명이 아니고 주석이 없는 것만 뺌 (type 만 바꾼 서명 payload 로 숨지 못하게)
  - 서명의 `image_repo`가 조회한 저장소와 다르면 다른 저장소에서 옮겨 온 서명 `foreign_signature`
  - 문제를 찾아도 멈추지 않고 이미지를 끝까지 봄. 찾은 것 전부 `findings`에 (첫 건이 종료 이유)
  - `--sweep`이면 저장소 태그를 crane 으로 전부 훑음 (cosign v3 는 서명 대상마다 `sha256-<digest>` 태그를 남김). 로그에 한 번도 안 나온 이미지에 한 서명까지 봄
    - 복사한 로그로 서명(운영자가 `SIGNER_AUDIT_LOG`를 사본으로 바꿈) → `unlogged_signature` "N번째 줄 뒤에서 갈라짐"
    - 훔친 키로 새 이미지에 직접 서명 → `--strict-images`와 같이 쓰면 `unlogged_signature`
    - 태그 없는 이미지는 `--digests-file` (예: `gcloud artifacts docker images list <저장소> --format='value(version)'`). `--digests-file`만 주면 태그는 안 훑음 (태그가 한도를 넘는 저장소를 목록으로 나눠 볼 때)
    - 빈 감사 로그를 훑을 땐 저장소를 몰라서 `--image-repo` 필요 (로그를 통째로 비워도 조용히 통과하지 않게)
    - 조회 실패는 빈 목록으로 통과시키지 않고 실행 오류 (`REGISTRY_UNAVAILABLE`, `CRANE_MISSING`, `SWEEP_TRUNCATED`)
    - 키 유출 조사: `--pub leaked.pub --images --sweep --json`으로 그 키로 한 서명을 뽑아 볼 수 있음
  - 키 교체 중(`--pub` 여러 개)엔 이미지가 한 키로만 서명돼 있어도 됨. 어느 키로도 확인되는 서명이 없을 때만 `signature_invalid`
  - 취소된 signed 줄(믿는 키로 안 보이는 서명이라 취소된 경우 등)은 맞는 서명이 없어도 됨
  - `--strict-images`·`--sweep`이면 예전 형식(`.sig` 태그) 서명도 따로 물어봄 (`--new-bundle-format=false`). cosign v3 는 새 형식 서명이 하나라도 있으면 예전 형식을 안 돌려줘서, 훔친 키로 예전 형식으로 붙인 서명이 숨을 수 있음
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
- 이미 있는 고정값과 지금 로그가 다르면(끝이 잘리거나 다시 씀) 새로 고정하지 않음 (`ANCHOR_CONFLICT`). 정기 고정이 고쳐진 로그를 그대로 인정하지 않게
- `audit:verify --anchors`가 고정값마다 확인하는 것
  - 서명이 믿는 공개키(`--pub`, 여러 개 가능)로 확인됨, 아니면 `anchor_signature_invalid`
  - 지금 로그에 그 줄이 있음, 없으면 끝이 잘린 것 `anchor_truncated`
  - 그 줄 hash가 고정값과 같음, 다르면 다시 쓴 것 `anchor_mismatch`
  - 고정값 파일이 비었거나 형식이 틀리면 `anchor_invalid`, 파일이 없으면 실행 오류 `ANCHORS_MISSING`
- 고정값 파일은 감사 로그와 다른 곳(다른 VM, 버킷, 팀 채널 등)에도 복사해 둬야 의미 있음. 둘 다 같이 지우면 못 잡음
- Rekor를 켜고(`--no-tlog` 없이) 고정하면 서명이 공개 투명성 로그에도 남아서, 그 시각에 로그가 거기까지 있었다는 걸 제3자가 확인 가능. 공개 로그라 hash·시각이 공개됨

### 감사 로그가 못 잡는 것

- 마지막 고정 뒤에 붙은 줄의 자르기·파일 통째 삭제. `--sweep` 없는 `--images`는 남은 로그에 있는 digest만 조회. 별도로 보관한 sign_result가 있으면 `verify --audit`으로 해당 서명 줄의 누락 확인 가능
- 고정값 파일까지 같이 지우거나 잘라낸 경우 (그래서 다른 곳에 복사)
- 마지막 서명 뒤에 붙은 거절 줄은 체인과 끝 고정으로만 보호 (서명 anchor 범위 밖)
- 서명하는 동안 다른 실행이 붙인 줄은 그 서명의 anchor 범위 밖
- `--sweep`은 알고 있는 저장소(signed 줄 저장소, `--image-repo`)만 훑음. 다른 저장소에 한 서명은 그 저장소를 `--image-repo`로 줘야 함
- OCI referrers API 만 쓰는 레지스트리에서 태그 없는 이미지에 붙은 서명은 `--digests-file`로만 찾음
- cosign 서명이 레지스트리에 올라간 직후 프로세스가 죽으면(backend 시간 초과 등) 기록 없는 서명이 남음 (`unlogged_signature`로 나옴)
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
- 공개키 파일에는 `PUBLIC KEY` PEM 블록 하나만 있어야 함 (`PUBKEY_INVALID`)
  - 블록이 여러 개면 Node 는 `PUBLIC KEY` 블록으로 지문을 내고 cosign 은 첫 블록으로 서명을 확인해서, 앞에 공격자 `RSA PUBLIC KEY` 블록을 끼워 넣으면 지문 고정을 피할 수 있었음
- `--self-verify`와 같이 쓰면 서명 직후 확인도 고정한 공개키로만 함. 개인키가 공개키와 안 맞으면 배포 때가 아니라 서명 순간에 잡힘
- KMS 키 주소는 지문을 여기서 계산할 수 없어서 고정하면 멈춤 (`PUBKEY_PIN_UNSUPPORTED`)

### 키 교체

- 교체하는 동안 예전 키·새 키를 둘 다 믿음: `--pub old.pub --pub new.pub` (또는 `COSIGN_PUBLIC_KEY=old.pub,new.pub`), 지문도 둘 다 고정
- 서명·증명서·감사 로그 고정값은 둘 중 아무 키로나 확인되면 통과. 공개키를 못 읽거나 레지스트리 접근 실패 같은 설정 오류는 다른 키 결과로 숨기지 않음
- 증명서가 정책(Rego)에 걸리면 다른 키 결과와 상관없이 `policy_denied`
- 예전 키로 서명한 이미지가 다 빠지면 예전 키를 목록에서 뺌

## 서명 환경

- 개인키 파일 권한: 다른 사용자도 읽을 수 있으면(예: 644) 서명할 때 경고. `SIGNER_STRICT_KEY_PERMS=1`이면 서명 안 함 (`KEY_PERMISSIONS`, 실행 오류). KMS 키·Windows는 안 봄
- `COSIGN_REPOSITORY`가 설정돼 있으면 cosign 을 부르지 않고 멈춤 (`COSIGN_ENV_UNSAFE`)
  - cosign 은 이 저장소에서 서명을 읽고 써서, 정상 서명만 복사해 둔 그림자 저장소를 가리키면 이미지 저장소에 붙은 몰래 한 서명이 감사에서 안 보임 (실제 cosign 으로 확인)
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
| 시험 | 증명서에 시험 결과가 있고, 통과했고, 한 건 이상 재생했고, 맞은 수 = 전체, 모든 조건에서 맞음 (0건 재생은 시험을 안 한 것) |
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

- 정책 파일도 지문을 고정할 수 있음 (`--policy-sha256` / `SIGNER_POLICY_SHA256`, 값은 `npm run fingerprint -- --policy <파일>`)
  - main 보호가 없어서 레포 쓰기 권한자가 strict.rego 끝에 `tested { true }` 한 줄만 붙여도 시험 조건이 무력해짐 (Rego 는 같은 이름 규칙을 OR 로 합침)
  - 확인한 바이트를 임시 파일로 써서 그 파일을 cosign 에 넘김 (확인한 뒤 바꿔치기해도 소용없음). `--json`에 `policy_sha256`, `policy_pinned`
  - 고정값은 레포 밖(VM 환경변수 등)에 둘 것. signer 코드나 cosign 바이너리를 고치는 공격은 못 막음
- `--attest`를 켜면 서명할 때 cosign을 한 번 더 부름 (Rekor 없이면 `--no-tlog`와 같이)
- 같은 이미지에 증명서가 여러 개면 sign_result와 같은 것 하나만 있으면 통과. 정책은 cosign이 증명서마다 검사

## 서명 철회 (`npm run revoke`)

서명은 한 번 붙으면 계속 유효해서, 나중에 취약점이 나오거나 정책이 바뀐 이미지를 예전 sign_result 로 다시 배포할 수 있음. 감사 로그에 철회 줄을 남김

```json
{"kind":"revoke","time":"…","digest":"sha256:…","run_id":"r-003","reason":"vulnerability","by":"carol","note":"CVE-…"}
```

- `--run-id` 없으면 이미지 전체: 그 이미지의 서명 전부 `revoked`, 다시 서명 요청도 거부 (`DIGEST_REVOKED`, 되돌릴 수 없어서 새로 빌드)
- `--run-id` 있으면 그 실행의 서명만 `revoked`, 그 실행은 다시 서명 안 함(`RUN_REVOKED`, 미리 철회도 같음). 같은 이미지를 새 실행으로 서명하는 건 됨
- 같은 철회를 다시 하면 새 줄 없이 "이미 철회돼 있음" (재시도해도 줄이 안 쌓임)
- 철회 줄도 체인의 한 줄이라 지우면 끝 고정값에서 걸림 (`audit --anchors`, `verify --audit --anchors`). `--anchors --key`를 주면 철회 직후 바로 끝 고정 (키가 없으면 철회 줄을 쓰기 전에 멈춤)
- `verify --latest`: 이 결과 뒤에 같은 저장소·겹치는 배포 위치로 더 새로 서명한 결과(취소·철회 안 된 것)가 있거나 같은 이미지가 block 됐으면 `superseded` (예전 결과 재사용·몰래 롤백). 정상 롤백은 새 실행으로 다시 서명
- 한계: 감사 로그를 보는 곳(`verify --audit`, `reconcile`)에서만 보임. 배포 쪽 cosign verify 는 철회를 모름

## 실제 배포 상태 대조 (`npm run reconcile`)

다른 검사는 레지스트리와 감사 로그만 맞춰 봐서, 배포 쪽이 sign_result 의 targets 를 고쳐 승인 안 된 곳(Cloud Run 등)에 띄워도 서명은 멀쩡함. 실제로 어디에 무엇이 떠 있는지 적은 관측 파일과 맞춰 봄

```json
{"kind":"observed","target":"cloud_run","image":"<저장소>@sha256:<hex>","observed_at":"…","source":"gcloud run revisions describe …"}
```

| 확인 | 실패하면 |
|---|---|
| 감사 로그에 그 이미지의 signed 줄이 있음 (취소된 것 제외) | `deploy_unlogged` |
| 레지스트리에 그 줄과 정확히 같은 서명이 있음 (쌍둥이·signer 밖 서명은 인정 안 함) | `deploy_unsigned` |
| 철회되지 않음 | `deploy_revoked` |
| 서명한 배포 위치(기록한 targets)에 관측한 위치가 있음 | `target_not_signed` |

- 관측값 만드는 법: Cloud Run 은 `gcloud run revisions describe <rev> --format='value(status.imageDigest)'`, 온프레는 `docker inspect --format '{{index .RepoDigests 0}}'`. 손으로 써도 됨
- 운영자가 아닌 사람(감사자)이 관측 파일을 만들 때만 의미 있음. backend 의 deploy_result.json 은 안 읽음 (운영자가 고칠 수 있는 파일)
- 형식이 틀린 관측 줄은 줄 번호와 같이 실행 오류 (`OBSERVED_INVALID`)
- 한계: 관측 시점 사이에 잠깐 띄웠다 내린 배포는 못 봄. 주석 기록이 없는 예전 줄은 배포 위치를 몰라서 `target_not_signed`

## 승인자 SSH 서명 (`--approvers`)

승인 기록(approval.json)은 그냥 JSON 파일이라, 파일을 쓸 수 있으면 누구 이름으로든 승인 기록을 만들 수 있음. 켜면 승인자가 자기 SSH 키로 서명한 승인 기록만 받음 (`ssh-keygen -Y sign/verify`, OpenSSH 8.1 이상)

```bash
# 승인자 명부 (ssh allowed_signers 형식). GitHub 에 등록한 공개키는 https://github.com/<id>.keys
echo "bob namespaces=\"hibiscus-approval\" $(curl -s https://github.com/bob.keys | head -1)" >> allowed_signers

# 승인자: 승인 기록 + 서명 (approval.json.sig). ssh-agent 를 쓰면 --ssh-key 에 공개키 파일
npm run approve -- --plan plan.json --requester alice --approver bob --out approval.json --ssh-key ~/.ssh/id_ed25519

# 서명·확인: 승인 기록이 명부의 bob 키로 서명됐는지
npm run sign -- ... --approval approval.json --approvers allowed_signers [--approvers-sha256 sha256:<지문>]
npm run verify -- --result sign_result.json --approval approval.json --approvers allowed_signers
```

- 확인하는 것: 서명이 명부에 승인자 id(`approval.json`의 approver)로 적힌 키인지, namespace 가 `hibiscus-approval`인지(같은 키로 한 git 커밋 서명은 안 됨), 승인 기록 바이트가 서명한 그대로인지
- 실패하면 `approval_mismatch`로 서명 거절 (서명 파일 없음, 다른 사람 키, 서명 뒤 고침, 명부에 없음)
- 서명한 키 지문을 서명 주석 `approval_key`와 배포 증명서 `approval_key`에 남김 → verify `--approvers`는 서명 때 확인한 키와도 맞춰 봄
- 서명 확인과 내용 읽기를 같은 바이트로 함. 명부도 지문 고정한 바이트를 임시 파일로 넘김 (확인한 뒤 바꿔치기해도 소용없게)
- 명부의 id 는 대소문자까지 승인 기록과 같아야 함 (ssh principal 비교). `valid-before` 같은 키 만료도 ssh 규칙대로
- 자동 승인(allow)은 승인자 서명이 필요 없음
- 지금 backend 는 승인 버튼을 누를 때 서명 없는 승인 기록을 만들어서, backend 에서 켜면 사람 승인이 전부 거절됨. 수동 CLI 흐름용이고 backend 연동은 팀 결정 뒤

## 배포 쪽 서명 확인

```bash
# 기존 방식 (backend-v2, onprem-agent): run_id·plan_hash만
cosign verify --key signer/keys/cosign.pub -a run_id=<run_id> -a plan_hash=<plan_hash> <저장소>@<digest>

# sign_result 전체까지: npm run verify 를 부르거나 주석을 더 붙임 (image_repo 는 encodeURIComponent 한 저장소)
cosign verify --key signer/keys/cosign.pub -a run_id=... -a plan_hash=... \
  -a targets=onprem+cloud_run -a failover_allowed=false -a approver=<승인자> -a image_repo=<인코딩한 저장소> <저장소>@<digest>
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
| `contracts/Observed.schema.json` | reconcile 관측 파일 한 줄 (signer 안에서만) |

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
bash scripts/attack-demo.sh            # DEMO_PORT=5055, DEMO_KEEP=1 이면 작업 폴더 남김 (cosign·crane·ssh-keygen 필요)
```

| 공격 | 잡는 곳 |
|---|---|
| block 결정 서명 요청, 승인자를 요청자 본인(대소문자만 바꿈)으로 | sign 거절 (`policy_block`, `self_approval`) |
| 손으로 만든 승인 기록 / 남의 SSH 키로 서명 / 서명 뒤 승인 시각 고침 | sign `--approvers` 거절 (`approval_mismatch`) |
| 다른 사용자도 읽을 수 있는 개인키 | sign 실행 오류 (`KEY_PERMISSIONS`) |
| 서명 뒤 targets에 cloud_run, approver, signed_at, plan 규칙 결과 바꾸기 | verify `signature_invalid` |
| 다른 이미지 digest, 이미지·서명을 다른 저장소로 복사, dry-run 결과 | verify `ref_invalid`, `repo_mismatch`, `dry_run` |
| 공격자 키로 서명 / 레포 공개키 바꿔치기 | verify `signature_invalid` / `PUBKEY_MISMATCH` |
| 팀 키를 훔쳐 signer 밖에서 직접 서명 (새 형식, 예전 `.sig` 형식) | audit `--strict-images` `unlogged_signature` |
| 복사한 로그로 서명, 훔친 키로 새 이미지 서명 | audit `--sweep` (두 건 다 `findings`) |
| 시험 실패 이미지 / 시험 0건을 통과로 표시 / 시험 결과 파일 바꿔치기 / 정책 파일에 한 줄 붙이기 | verify `policy_denied` (strict.rego) / `policy_denied` / `attestation_invalid` / `POLICY_PIN_MISMATCH` |
| 감사 로그 한 줄 수정 / 끝 자르기 / 서명 줄 빼기 / 빼고 체인 다시 계산 | audit `hash_mismatch` / `anchor_truncated` / verify `audit_mismatch` / audit `--images` `unlogged_signature` |
| v2 뒤에 v1 결과로 배포 / 철회한 v2 배포 / 철회 줄 지우기 / 철회 이미지 다시 서명 | verify `superseded` / `revoked` / verify·audit `--anchors` `anchor_truncated` / sign `DIGEST_REVOKED` |
| targets 를 고쳐 Cloud Run 에 배포, 철회한 이미지·로그에 없는 이미지가 떠 있음 | reconcile `target_not_signed` / `deploy_revoked` / `deploy_unlogged` |

- 정상 흐름(서명, 증명서, 끝 고정, 전체 확인, 키 교체 중 확인)은 통과해야 함. 기대와 다르면 종료 코드 1
- 체인만 보면 통과하는 것, 정책 파일 한 줄 고치기처럼 지문 고정 없이는 통과하는 것(약점)도 같이 보여줌

## 테스트

```bash
npm test
npm run typecheck
bash scripts/attack-demo.sh   # 실제 cosign 으로 끝까지 (cosign·crane 필요)
```
