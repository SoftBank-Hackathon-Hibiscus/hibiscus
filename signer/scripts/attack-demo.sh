#!/usr/bin/env bash
# 공격 시연: 서명한 뒤에 결과·기록·키를 몰래 바꾸면 signer 가 어디서 잡는지 차례로 보여줌
# 로컬 레지스트리(crane)와 임시 키만 씀. 팀 키·GCP·공개 Rekor 는 안 씀 (Rekor 끈 모드)
#
# 필요: cosign v3, crane, node (signer 에서 npm ci 끝난 상태), ssh-keygen (OpenSSH 8.1 이상)
# 실행: cd signer && bash scripts/attack-demo.sh
#   DEMO_PORT=5055  로컬 레지스트리 포트
#   DEMO_KEEP=1     끝나도 작업 폴더를 지우지 않음 (파일 직접 보고 싶을 때)
set -uo pipefail
cd "$(dirname "$0")/.."

for bin in cosign crane node ssh-keygen; do
  command -v "$bin" >/dev/null || { echo "필요한 도구가 없음: $bin"; exit 2; }
done
[ -x node_modules/.bin/tsx ] || { echo "signer 에서 npm ci 를 먼저 실행"; exit 2; }

# 사용자 환경변수가 시연 결과를 바꾸지 않게 비움
unset SIGNER_COSIGN_KEY SIGNER_AUDIT_LOG SIGNER_AUDIT_ANCHORS SIGNER_PUBKEY_SHA256 COSIGN_PUBLIC_KEY IMAGE_REPO \
  SIGNER_SELF_VERIFY SIGNER_ATTEST SIGNER_MINIMAL_ENV SIGNER_STRICT_KEY_PERMS SIGNER_MAX_AGE_MIN SIGNER_APPROVAL_TTL_MIN \
  SIGNER_NO_TLOG SIGNER_VERIFY_LATEST SIGNER_POLICY_SHA256 SIGNER_AUDIT_SWEEP SIGNER_APPROVERS SIGNER_APPROVERS_SHA256 COSIGN_REPOSITORY

PORT="${DEMO_PORT:-5055}"
REG="localhost:$PORT/hib/todo"
W="$(mktemp -d "${TMPDIR:-/tmp}/signer-attack-demo.XXXXXX")"
REG_PID=""
cleanup() {
  [ -n "$REG_PID" ] && { kill "$REG_PID" && wait "$REG_PID"; } 2>/dev/null
  if [ "${DEMO_KEEP:-}" = "1" ]; then echo "작업 폴더: $W"; else rm -rf "$W"; fi
}
trap cleanup EXIT

SIGNER=(node_modules/.bin/tsx src/cli.ts)
signer() { "${SIGNER[@]}" "$@"; }
export COSIGN_PASSWORD=attack-demo

# --- 출력 ---
total=0
wrong=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
# check <기대 종료 코드> <설명> <명령...>: 명령을 실행하고, 종료 코드가 기대와 같은지와 signer 가 남긴 이유 한 줄을 보여줌
check() {
  local want="$1" title="$2"
  shift 2
  total=$((total + 1))
  local out code
  out="$("$@" 2>&1)"
  code=$?
  local why
  why="$(printf '%s\n' "$out" | grep -v -e '^WARNING' -e 'insecure practice' | grep -m1 -e '\[signer\]' -e '^{')"
  [ ${#why} -gt 220 ] && why="${why:0:217}..."
  # audit 가 문제를 여러 건 찾으면 건마다 한 줄씩 더 나옴
  local more
  more="$(printf '%s\n' "$out" | grep -E '^  ([0-9]+번째 줄 )?\([a-z_]+\): ' | head -3 | while IFS= read -r l; do [ ${#l} -gt 200 ] && l="${l:0:197}..."; printf '%s\n' "$l"; done)"
  if [ "$code" = "$want" ]; then
    printf '  \033[32m✔\033[0m %s\n      exit %s  %s\n' "$title" "$code" "$why"
    [ -n "$more" ] && printf '%s\n' "$more" | sed 's/^/      /'
  else
    wrong=$((wrong + 1))
    printf '  \033[31m✘\033[0m %s (기대 exit %s, 실제 %s)\n' "$title" "$want" "$code"
    printf '%s\n' "$out" | sed 's/^/      /' | tail -5
  fi
}
# 감사 로그에서 signed 줄을 빼고 seq·prev_hash·hash 를 다시 계산 (체인을 통째로 고쳐 쓰는 공격): recompute <원본> <결과>
recompute() {
  node_modules/.bin/tsx --eval '
import { readFileSync, writeFileSync } from "node:fs";
import { auditHash, GENESIS } from "./src/audit.ts";
const [src, out] = process.argv.slice(-2);
let prev = GENESIS;
const kept = readFileSync(src, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.entry.result !== "signed" && l.cancels === undefined);
const lines = kept.map((l, i) => { const { hash: _h, ...body } = { ...l, seq: i + 1, prev_hash: prev }; prev = auditHash(body); return { ...body, hash: prev }; });
writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
' "$1" "$2"
}
# json 파일 일부를 바꿔서 새 파일로: edit <원본> <결과> <JS 식(o 를 고침)>
edit() { node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));(new Function("o",process.argv[3]))(o);fs.writeFileSync(process.argv[2],JSON.stringify(o,null,2))' "$1" "$2" "$3"; }

# --- 준비 ---
step "준비: 로컬 레지스트리, 이미지 2개, 팀 키·공격자 키"
crane registry serve --address "localhost:$PORT" >"$W/registry.log" 2>&1 &
REG_PID=$!
for _ in $(seq 50); do crane catalog "localhost:$PORT" >/dev/null 2>&1 && break; sleep 0.1; done
crane catalog "localhost:$PORT" >/dev/null 2>&1 || { echo "레지스트리가 안 뜸 (포트 $PORT 사용 중?)"; cat "$W/registry.log"; exit 2; }

tar cf "$W/v1.tar" -T /dev/null
echo v2 >"$W/v2" && tar cf "$W/v2.tar" -C "$W" v2
echo v3 >"$W/v3" && tar cf "$W/v3.tar" -C "$W" v3
crane append -f "$W/v1.tar" -t "$REG:v1" >/dev/null 2>&1
crane append -f "$W/v2.tar" -t "$REG:v2" >/dev/null 2>&1
D1="$(crane digest "$REG:v1")"
crane append -f "$W/v3.tar" -t "$REG:v3" >/dev/null 2>&1
D2="$(crane digest "$REG:v2")"
D3="$(crane digest "$REG:v3")"

mkdir -p "$W/team" "$W/next" "$W/evil"
for k in team next evil; do (cd "$W/$k" && cosign generate-key-pair >/dev/null 2>&1); done
KEY="$W/team/cosign.key"
PUB="$W/team/cosign.pub"
FP="$(signer fingerprint --pub "$PUB" | grep -o 'sha256:[0-9a-f]*')"

# 개인정보(R4) 앱 todo: 온프레만 허용된 plan. 시험 결과는 policy 픽스처를 이 이미지 것으로 바꿔 씀
edit fixtures/plans/allow-onprem.plan.json "$W/plan.json" "o.digest='$D1'"
edit ../policy/fixtures/01-allow/test_result.json "$W/test.json" "o.run_id='r-003';o.digest='$D1'"
edit fixtures/plans/needs-approval.plan.json "$W/plan-na.json" "o.digest='$D1'"
edit fixtures/plans/block.plan.json "$W/plan-block.json" "o.digest='$D1'"
# 두 번째 이미지: 시험에서 20건 중 19건만 맞음
edit fixtures/plans/allow-onprem.plan.json "$W/plan2.json" "o.run_id='r-103';o.digest='$D2'"
edit ../policy/fixtures/01-allow/test_result.json "$W/test2.json" "o.run_id='r-103';o.digest='$D2';o.passed=false;o.match.matched=o.match.total-1"
# 세 번째 이미지: 시험을 0건 재생하고 통과로 표시
edit fixtures/plans/allow-onprem.plan.json "$W/plan3.json" "o.run_id='r-104';o.digest='$D3'"
edit ../policy/fixtures/01-allow/test_result.json "$W/test3.json" "o.run_id='r-104';o.digest='$D3';o.passed=true;o.match={total:0,matched:0}"
echo "  이미지 v1 $D1"
echo "  이미지 v2 $D2"
echo "  팀 공개키 $FP"

SIGN=(--requester alice --image-repo "$REG" --log "$W/decisions.jsonl" --audit "$W/audit.jsonl" --no-tlog)
VERIFY=(--pub "$PUB" --pubkey-sha256 "$FP" --no-tlog)

# --- 정상 흐름 ---
step "정상: 서명 → 증명서 → 감사 로그 → 끝 고정 → 확인"
check 0 "v1 서명 (서명 직후 자체 확인, 배포 증명서·시험 결과 첨부)" \
  env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan.json" "${SIGN[@]}" --attest --test-result "$W/test.json" --self-verify --pub "$PUB" --out "$W/sr.json"
check 0 "v2 서명 (시험 1건 실패한 이미지, 기본 정책은 서명함)" \
  env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan2.json" "${SIGN[@]}" --attest --test-result "$W/test2.json" --out "$W/sr2.json"
check 0 "감사 로그 끝 고정 (anchor)" \
  signer anchor --audit "$W/audit.jsonl" --anchors "$W/anchors.jsonl" --key "$KEY" --no-tlog
check 0 "v1 배포 전 확인: 서명 주석 전부 + plan + 감사 로그 + 증명서(strict.rego) + 10분 안" \
  signer verify --result "$W/sr.json" --plan "$W/plan.json" --audit "$W/audit.jsonl" --attestation --policy policy/strict.rego --test-result "$W/test.json" --max-age 10 "${VERIFY[@]}"
check 0 "감사 로그 확인: 체인 + 끝 고정값 + 레지스트리 서명 대조 (로그에 없는 서명 엄격히)" \
  signer audit --audit "$W/audit.jsonl" --anchors "$W/anchors.jsonl" --images --strict-images --image-repo "$REG" "${VERIFY[@]}"
check 0 "키 교체 중(지금 키·다음 키 둘 다 믿음)에도 확인 통과" \
  signer audit --audit "$W/audit.jsonl" --images --image-repo "$REG" --pub "$W/next/cosign.pub" --pub "$PUB" --no-tlog

# --- 서명 단계 공격 ---
step "공격 1. 서명을 받아 내려는 시도"
check 1 "정책이 막은(block) 배포를 서명 요청" \
  env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan-block.json" "${SIGN[@]}" --out "$W/x.json"
signer approve --plan "$W/plan-na.json" --requester alice --approver bob --out "$W/approval.json" >/dev/null 2>&1
edit "$W/approval.json" "$W/approval-self.json" "o.approver='ALICE'"
check 1 "승인 기록의 승인자를 요청자 본인(대소문자만 바꿈)으로 고침" \
  env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan-na.json" --approval "$W/approval-self.json" "${SIGN[@]}" --out "$W/x.json"
# 승인자 SSH 서명: 명부(allowed_signers)에는 bob 만. 확인용 서명은 시험 실행(--dry-run)으로 해서 레지스트리·감사 로그는 안 건드림
mkdir -p "$W/ssh"
for who in bob mallory; do ssh-keygen -q -t ed25519 -N "" -C "$who" -f "$W/ssh/$who"; done
echo "bob namespaces=\"hibiscus-approval\" $(cat "$W/ssh/bob.pub")" >"$W/allowed_signers"
SIGN_NA=(--plan "$W/plan-na.json" --requester alice --image-repo "$REG" --log "$W/x.jsonl" --dry-run --approvers "$W/allowed_signers" --out "$W/x.json")
check 1 "승인자 명부를 켰는데 서명 없이 손으로 만든 bob 승인 기록" \
  signer sign "${SIGN_NA[@]}" --approval "$W/approval.json"
ssh-keygen -Y sign -f "$W/ssh/mallory" -n hibiscus-approval <"$W/approval.json" >"$W/approval.json.sig" 2>/dev/null
check 1 "mallory 가 자기 SSH 키로 bob 이름 승인 기록에 서명" \
  signer sign "${SIGN_NA[@]}" --approval "$W/approval.json"
signer approve --plan "$W/plan-na.json" --requester alice --approver bob --ssh-key "$W/ssh/bob" --out "$W/approval-bob.json" >/dev/null 2>&1
check 0 "bob 이 자기 SSH 키로 서명한 승인 기록" \
  signer sign "${SIGN_NA[@]}" --approval "$W/approval-bob.json"
edit "$W/approval-bob.json" "$W/approval-bob2.json" "o.approved_at=new Date().toISOString()"
cp "$W/approval-bob.json.sig" "$W/approval-bob2.json.sig"
check 1 "bob 서명 뒤 승인 시각을 고친 승인 기록" \
  signer sign "${SIGN_NA[@]}" --approval "$W/approval-bob2.json"
chmod 644 "$KEY"
check 2 "다른 사용자도 읽을 수 있는 개인키로 서명 (SIGNER_STRICT_KEY_PERMS=1)" \
  env SIGNER_COSIGN_KEY="$KEY" SIGNER_STRICT_KEY_PERMS=1 "${SIGNER[@]}" sign --plan "$W/plan.json" "${SIGN[@]}" --out "$W/x.json"
chmod 600 "$KEY"

# --- 서명 뒤 결과 조작 ---
step "공격 2. 서명 뒤에 sign_result·plan 바꾸기 (배포 직전 verify 에서 잡힘)"
edit "$W/sr.json" "$W/sr-cloud.json" "o.targets=['onprem','cloud_run'];o.failover_allowed=true"
check 1 "개인정보 앱 targets 에 cloud_run 끼워 넣기" signer verify --result "$W/sr-cloud.json" "${VERIFY[@]}"
edit "$W/sr.json" "$W/sr-approver.json" "o.approver='bob'"
check 1 "자동 승인을 사람 승인처럼 approver 바꾸기" signer verify --result "$W/sr-approver.json" "${VERIFY[@]}"
edit "$W/sr.json" "$W/sr-time.json" "o.signed_at=new Date().toISOString()"
check 1 "서명 시각을 지금으로 고쳐 유효기간(--max-age) 우회" signer verify --result "$W/sr-time.json" "${VERIFY[@]}"
edit "$W/plan.json" "$W/plan-rules.json" "o.rules.find(r=>r.id==='R4').result='not_matched'"
check 1 "plan.json 의 개인정보 규칙(R4) 결과를 not_matched 로" signer verify --result "$W/sr.json" --plan "$W/plan-rules.json" "${VERIFY[@]}"
edit "$W/sr.json" "$W/sr-digest.json" "o.digest='$D2'"
check 1 "서명 안 받은 다른 이미지(v2) digest 로 바꾸기" signer verify --result "$W/sr-digest.json" "${VERIFY[@]}"
# 레지스트리 쓰기 권한자가 이미지와 서명을 다른 저장소로 복사 (cosign v3 는 sha256-<digest> 태그에 서명 목록을 둠)
OTHER="localhost:$PORT/hib/other"
crane cp "$REG@$D1" "$OTHER@$D1" >/dev/null 2>&1
crane cp "$REG:sha256-${D1#sha256:}" "$OTHER:sha256-${D1#sha256:}" >/dev/null 2>&1
edit "$W/sr.json" "$W/sr-other.json" "o.signature_ref='cosign:$OTHER@$D1'"
check 1 "v1 이미지·서명을 다른 저장소로 복사하고 signature_ref 만 고침" \
  signer verify --result "$W/sr-other.json" --image-repo "$OTHER" "${VERIFY[@]}"
env SIGNER_COSIGN_KEY= "${SIGNER[@]}" sign --plan "$W/plan.json" --requester alice --image-repo "$REG" --log "$W/x.jsonl" --dry-run --out "$W/sr-dry.json" >/dev/null 2>&1
check 1 "cosign 없이 만든 dry-run 결과로 배포" signer verify --result "$W/sr-dry.json" "${VERIFY[@]}"

# --- 키 공격 ---
step "공격 3. 키 바꿔치기·도용"
edit "$W/plan.json" "$W/plan-evil.json" "o.targets=['onprem','cloud_run'];o.failover_allowed=true"
env SIGNER_COSIGN_KEY="$W/evil/cosign.key" "${SIGNER[@]}" sign --plan "$W/plan-evil.json" --requester alice --image-repo "$REG" --log "$W/x.jsonl" --no-tlog --out "$W/sr-evil.json" >/dev/null 2>&1
check 1 "공격자 키로 직접 서명한 이미지·결과 (팀 공개키로 확인)" signer verify --result "$W/sr-evil.json" "${VERIFY[@]}"
check 2 "레포의 cosign.pub 를 공격자 공개키로 바꿔치기 (지문 고정)" \
  signer verify --result "$W/sr-evil.json" --pub "$W/evil/cosign.pub" --pubkey-sha256 "$FP" --no-tlog
# 팀 키를 훔쳐 signer 를 거치지 않고 cosign 으로 직접 서명. 서명 자체는 진짜라 verify 만으로는 못 막음
cosign sign --yes --key "$KEY" --use-signing-config=false --tlog-upload=false -a run_id=r-999 -a targets=onprem+cloud_run "$REG@$D2" >/dev/null 2>&1
check 1 "팀 키를 훔쳐 signer 밖에서 직접 서명: 감사 로그에 없는 서명이 레지스트리에 생김 (--strict-images)" \
  signer audit --audit "$W/audit.jsonl" --images --strict-images --image-repo "$REG" "${VERIFY[@]}"

# --- 감사 로그 밖 서명 (별도 저장소·로그) ---
step "공격 3-2. 감사 로그 밖에서 한 서명 (레지스트리 훑기)"
REG2="localhost:$PORT/hib/billing"
for n in 1 2 3; do
  echo "b$n" >"$W/b$n" && tar cf "$W/b$n.tar" -C "$W" "b$n" && crane append -f "$W/b$n.tar" -t "$REG2:b$n" >/dev/null 2>&1
done
B1="$(crane digest "$REG2:b1")"
B2="$(crane digest "$REG2:b2")"
B3="$(crane digest "$REG2:b3")"
edit fixtures/plans/allow-onprem.plan.json "$W/plan-b1.json" "o.run_id='r-201';o.digest='$B1'"
edit fixtures/plans/allow-onprem.plan.json "$W/plan-b2.json" "o.run_id='r-202';o.digest='$B2'"
SIGN_B=(--requester alice --image-repo "$REG2" --log "$W/decisions-b.jsonl" --no-tlog)
env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan-b1.json" "${SIGN_B[@]}" --audit "$W/audit-b.jsonl" --out "$W/sb1.json" >/dev/null 2>&1
# 운영자가 한 번만 SIGNER_AUDIT_LOG 를 진짜 로그 사본으로 바꿔 서명
cp "$W/audit-b.jsonl" "$W/fork-b.jsonl"
env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan-b2.json" "${SIGN_B[@]}" --audit "$W/fork-b.jsonl" --out "$W/sb2.json" >/dev/null 2>&1
# 훔친 키로 로그에 한 번도 안 나온 새 이미지에 직접 서명
cosign sign --yes --key "$KEY" --use-signing-config=false --tlog-upload=false -a run_id=r-998 "$REG2@$B3" >/dev/null 2>&1
check 0 "(약점) 복사한 로그로 한 서명·signer 밖 새 이미지 서명: --strict-images 로도 안 보임" \
  signer audit --audit "$W/audit-b.jsonl" --images --strict-images --image-repo "$REG2" "${VERIFY[@]}"
check 1 "--sweep: 저장소 태그를 다 훑어서 두 건 다 찾음" \
  signer audit --audit "$W/audit-b.jsonl" --images --strict-images --sweep --image-repo "$REG2" "${VERIFY[@]}"
# 훔친 키로 예전 형식(.sig) 서명: cosign v3 는 새 형식 서명이 있으면 기본 목록에 예전 형식을 안 넣음
REG3="localhost:$PORT/hib/legacy"
echo l1 >"$W/l1" && tar cf "$W/l1.tar" -C "$W" l1 && crane append -f "$W/l1.tar" -t "$REG3:l1" >/dev/null 2>&1
L1="$(crane digest "$REG3:l1")"
edit fixtures/plans/allow-onprem.plan.json "$W/plan-l1.json" "o.run_id='r-301';o.digest='$L1'"
env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan-l1.json" --requester alice --image-repo "$REG3" --log "$W/decisions-l.jsonl" --no-tlog \
  --audit "$W/audit-l.jsonl" --out "$W/sl1.json" >/dev/null 2>&1
cosign sign --yes --key "$KEY" --use-signing-config=false --tlog-upload=false --new-bundle-format=false -a run_id=r-997 -a targets=onprem+cloud_run "$REG3@$L1" >/dev/null 2>&1
check 1 "훔친 키로 예전 형식(.sig) 서명을 붙임: --strict-images 가 예전 형식도 따로 물어봐서 찾음" \
  signer audit --audit "$W/audit-l.jsonl" --images --strict-images --image-repo "$REG3" "${VERIFY[@]}"

# --- 증명서 정책 ---
step "공격 4. 시험에 실패한 이미지 배포"
check 1 "v2: 서명은 맞지만 증명서의 시험 결과가 strict.rego 에 걸림" \
  signer verify --result "$W/sr2.json" --attestation --policy policy/strict.rego "${VERIFY[@]}"
check 1 "v2: 시험 결과 파일을 통과한 것(v1 것)으로 바꿔 제출" \
  signer verify --result "$W/sr2.json" --attestation --test-result "$W/test.json" "${VERIFY[@]}"
env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan3.json" --requester alice --image-repo "$REG" --log "$W/x.jsonl" --no-tlog \
  --attest --test-result "$W/test3.json" --out "$W/sr3.json" >/dev/null 2>&1
check 1 "v3: 시험을 0건 재생하고 통과로 표시한 결과 (strict.rego)" \
  signer verify --result "$W/sr3.json" --attestation --policy policy/strict.rego "${VERIFY[@]}"
# 레포 쓰기 권한자가 정책 끝에 한 줄만 붙임 (Rego 는 같은 이름 규칙을 OR 로 합쳐서 시험 조건이 무력해짐)
{ cat policy/strict.rego; echo 'tested { true }'; } >"$W/strict-weak.rego"
check 0 "(약점) strict.rego 끝에 'tested { true }' 한 줄: 시험 실패 v2 통과" \
  signer verify --result "$W/sr2.json" --attestation --policy "$W/strict-weak.rego" "${VERIFY[@]}"
PFP="$(signer fingerprint --policy policy/strict.rego | grep -o 'sha256:[0-9a-f]*')"
check 2 "같은 정책을 지문 고정(--policy-sha256)으로 확인" \
  signer verify --result "$W/sr2.json" --attestation --policy "$W/strict-weak.rego" --policy-sha256 "$PFP" "${VERIFY[@]}"
check 1 "원본 정책 + 지문 고정: 원래대로 거절" \
  signer verify --result "$W/sr2.json" --attestation --policy policy/strict.rego --policy-sha256 "$PFP" "${VERIFY[@]}"

# --- 기록 조작 ---
step "공격 5. 감사 로그 조작"
signer anchor --audit "$W/audit.jsonl" --anchors "$W/anchors.jsonl" --key "$KEY" --no-tlog >/dev/null 2>&1
sed '1s/"requester":"alice"/"requester":"mallory"/' "$W/audit.jsonl" >"$W/audit-edit.jsonl"
check 1 "첫 줄 요청자를 mallory 로 고침" signer audit --audit "$W/audit-edit.jsonl"
sed '$d' "$W/audit.jsonl" >"$W/audit-cut.jsonl"
check 0 "(약점) 마지막 기록(승인 거절 줄) 삭제: 체인만 보면 통과함" signer audit --audit "$W/audit-cut.jsonl"
check 1 "같은 파일을 끝 고정값과 맞춰 봄" signer audit --audit "$W/audit-cut.jsonl" --anchors "$W/anchors.jsonl" "${VERIFY[@]}"
grep -v '"result":"signed"' "$W/audit.jsonl" >"$W/audit-nosign.jsonl"
check 1 "서명 기록 줄만 삭제한 로그로 v1 배포 확인 (seq_gap)" \
  signer verify --result "$W/sr.json" --audit "$W/audit-nosign.jsonl" "${VERIFY[@]}"
recompute "$W/audit.jsonl" "$W/audit-rechain.jsonl"
check 0 "(약점) 서명 기록 줄을 빼고 체인을 다시 계산: 체인만 보면 통과함" signer audit --audit "$W/audit-rechain.jsonl"
check 1 "같은 로그로 v1 배포 확인: 이 서명 결과의 signed 줄이 없음" \
  signer verify --result "$W/sr.json" --audit "$W/audit-rechain.jsonl" "${VERIFY[@]}"
check 1 "같은 로그를 레지스트리 서명과 맞춰 봄: 로그에 없는 서명" \
  signer audit --audit "$W/audit-rechain.jsonl" --images --image-repo "$REG" "${VERIFY[@]}"

# --- 예전 서명 재사용 ---
step "공격 6. 예전 서명 재사용·철회한 이미지"
check 1 "v2 가 나온 뒤 v1 결과로 배포 (몰래 롤백, --latest)" \
  signer verify --result "$W/sr.json" --audit "$W/audit.jsonl" --latest "${VERIFY[@]}"
check 0 "v2 결과는 가장 새 결과라 통과" \
  signer verify --result "$W/sr2.json" --audit "$W/audit.jsonl" --latest "${VERIFY[@]}"
signer revoke --audit "$W/audit.jsonl" --digest "$D2" --reason vulnerability --by carol --note "CVE 발견" \
  --anchors "$W/anchors.jsonl" --key "$KEY" --no-tlog >/dev/null 2>&1
check 1 "v2 를 철회한 뒤 v2 결과로 배포" \
  signer verify --result "$W/sr2.json" --audit "$W/audit.jsonl" "${VERIFY[@]}"
sed '$d' "$W/audit.jsonl" >"$W/audit-unrevoke.jsonl"
check 0 "(약점) 철회 줄을 지운 감사 로그로 v2 배포 확인: 끝 고정값을 안 보면 통과" \
  signer verify --result "$W/sr2.json" --audit "$W/audit-unrevoke.jsonl" "${VERIFY[@]}"
check 1 "같은 로그로 배포 확인 + 끝 고정값 (--anchors)" \
  signer verify --result "$W/sr2.json" --audit "$W/audit-unrevoke.jsonl" --anchors "$W/anchors.jsonl" "${VERIFY[@]}"
check 1 "같은 로그를 감사 (끝 고정값과 맞춰 봄)" \
  signer audit --audit "$W/audit-unrevoke.jsonl" --anchors "$W/anchors.jsonl" "${VERIFY[@]}"
check 2 "철회한 이미지를 다시 서명 요청" \
  env SIGNER_COSIGN_KEY="$KEY" "${SIGNER[@]}" sign --plan "$W/plan2.json" "${SIGN[@]}" --out "$W/x.json"

# --- 실제 배포 상태 ---
step "공격 7. 고친 sign_result 로 배포한 뒤 실제 상태 대조"
observed() { printf '{"kind":"observed","target":"%s","image":"%s","observed_at":"2026-10-03T00:00:00Z","source":"demo"}\n' "$1" "$2"; }
observed onprem "$REG@$D1" >"$W/observed-ok.jsonl"
{
  observed onprem "$REG@$D1"
  observed cloud_run "$REG@$D1"
  observed onprem "$REG@$D2"
  observed onprem "$REG2@$B3"
} >"$W/observed.jsonl"
check 0 "정상 배포만 있는 관측 (v1 이 온프레에)" \
  signer reconcile --observed "$W/observed-ok.jsonl" --audit "$W/audit.jsonl" "${VERIFY[@]}"
check 1 "운영자가 targets 를 고쳐 v1 을 Cloud Run 에도, 철회한 v2, 로그에 없는 b3 가 떠 있음" \
  signer reconcile --observed "$W/observed.jsonl" --audit "$W/audit.jsonl" "${VERIFY[@]}"

# --- 결과 ---
step "결과"
if [ "$wrong" -eq 0 ]; then
  echo "  $total개 모두 기대대로 (정상은 통과, 공격은 전부 거절)"
else
  echo "  $total개 중 $wrong개가 기대와 다름"
  exit 1
fi
