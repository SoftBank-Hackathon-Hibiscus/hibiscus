#!/usr/bin/env python3
"""배포 조율기 v1 (준하)

sign_result.json을 받아 서명을 확인한 뒤 대상별 후보 배포 -> 검사 -> 전환(또는 유지)을 실행하고
OUT_DIR/deploy_result.json에 결과를 남긴다.

v1에서 바뀐 것
- sign_result를 루트 contracts/SignResult.schema.json으로 검사
- 서명 확인: dry-run 거부, signature_ref의 digest 일치, cosign verify -a run_id -a plan_hash
- 이미지 주소는 signature_ref(cosign:<저장소>@<digest>)에서 꺼낸다 (서명한 그 이미지 그대로)
- 후보 revision에 HIB_RUN_ID, HIB_DIGEST 환경변수 (Cloud Run이 인덱스 digest를 amd64로 바꿔 기록하므로)
- 결과 파일 이름 고정: OUT_DIR/deploy_result.json (backend의 <run>/deploy/)
- --migration, --pii-possible 옵션 (롤백 판단용. 지금은 기록만)

비어 있는 자리 (태현님과 형식 확정 후 채움)
- 온프레: 작업함(GCS) 연결 전이라 skipped로 기록
- 검사: 후보 주소 HTTP 200만 보는 임시 검사. 태현님 검사 CLI로 교체 예정
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
CLOUDRUN = HERE.parent / "cloudrun"
SIGN_SCHEMA = REPO_ROOT / "contracts" / "SignResult.schema.json"
DEFAULT_KEY = REPO_ROOT / "signer" / "keys" / "cosign.pub"
KNOWN_TARGETS = ("cloud_run", "onprem")          # 전환 순서도 이 순서 (Cloud Run 먼저)
REQUIRED = ("run_id", "digest", "plan_hash", "targets", "failover_allowed",
            "requester", "approver", "signature_ref", "signed_at")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
EXIT_CODE = {"activated": 0, "held": 3, "rolled_back": 4}


class Reject(Exception):
    """배포를 시작하면 안 되는 입력 (형식, 서명 문제)"""


def now():
    return datetime.now(KST).isoformat(timespec="seconds")


def log(msg):
    print(f"[coordinator] {msg}", file=sys.stderr)


def parse_args():
    p = argparse.ArgumentParser(description="배포 조율기: sign_result.json -> 후보 -> 검사 -> 전환")
    p.add_argument("sign_result", help="서명 단계가 만든 sign_result.json")
    p.add_argument("--migration", help="같은 run의 migration.json 경로 (롤백 판단용)")
    p.add_argument("--pii-possible", action="store_true",
                   help="정책에서 개인정보 가능성(R4)이 걸린 실행 (롤백 판단용)")
    p.add_argument("--out-dir", default=os.environ.get("OUT_DIR", str(HERE.parent / "out")),
                   help="deploy_result.json을 쓸 폴더 (기본: OUT_DIR 환경변수)")
    return p.parse_args()


def load_sign_result(path):
    data = json.loads(Path(path).read_text())
    try:
        import jsonschema
    except ImportError:
        jsonschema = None
    if jsonschema is not None:
        try:
            jsonschema.validate(data, json.loads(SIGN_SCHEMA.read_text()))
        except jsonschema.ValidationError as e:
            raise Reject(f"sign_result 계약 위반: {e.message}")
    else:
        log("jsonschema가 없어 필수 필드만 직접 확인함")
        missing = [k for k in REQUIRED if k not in data]
        if missing:
            raise Reject(f"sign_result 필수 필드 없음: {missing}")
    if not RUN_ID_RE.match(data["run_id"]):
        raise Reject(f"run_id 형식 오류: {data['run_id']}")
    if not DIGEST_RE.match(data["digest"]):
        raise Reject(f"digest 형식 오류: {data['digest']}")
    unknown = [t for t in data["targets"] if t not in KNOWN_TARGETS]
    if unknown:
        raise Reject(f"알 수 없는 배포 대상: {unknown}")
    return data


def verify_signature(sign):
    """서명 확인. 통과하면 배포할 이미지 주소와 사용한 공개키 경로를 돌려준다"""
    ref = sign["signature_ref"]
    if ref.startswith("dry-run:"):
        raise Reject(f"dry-run 서명은 배포하지 않음 ({ref})")
    if not ref.startswith("cosign:"):
        raise Reject(f"지원하지 않는 서명 형식: {ref}")
    image_ref = ref[len("cosign:"):]
    if not image_ref.endswith("@" + sign["digest"]):
        raise Reject("서명한 이미지의 digest가 sign_result.digest와 다름")
    key = os.environ.get("COSIGN_PUBLIC_KEY", str(DEFAULT_KEY))
    cmd = ["cosign", "verify", "--key", key,
           "-a", f"run_id={sign['run_id']}", "-a", f"plan_hash={sign['plan_hash']}", image_ref]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        lines = proc.stderr.strip().splitlines() or ["(출력 없음)"]
        raise Reject(f"서명 확인 실패: {lines[-1]}")
    log(f"서명 확인 통과 (key={key})")
    return image_ref, key


def run_script(name, *args):
    """cloudrun 스크립트를 실행하고 마지막 줄 JSON을 돌려준다. gcloud 진행 메시지는 화면에 그대로 보인다"""
    proc = subprocess.run([str(CLOUDRUN / name), *args], stdout=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{name} 실패 (종료 코드 {proc.returncode})")
    return json.loads(proc.stdout.strip().splitlines()[-1])


# ---- Cloud Run (준하) ----
def cloudrun_candidate(image_ref, run_id):
    return run_script("candidate.sh", image_ref, "", run_id)


def cloudrun_activate():
    return run_script("activate.sh")


def cloudrun_rollback(revision):
    return run_script("rollback.sh", revision)


def cloudrun_discard():
    return run_script("discard.sh")


# ---- 온프레 (태현님 에이전트 자리. 작업함 연결 전이라 호출하지 않는다) ----
def onprem_candidate(image_ref, run_id):
    return {"target": "onprem", "phase": "candidate", "result": "skipped",
            "reason": "onprem mailbox not connected yet"}


# ---- 검사 (임시. 태현님 검사 CLI로 교체 예정) ----
def run_check(target, url, tries=3):
    path = os.environ.get("CHECK_PATH", "/")
    started = time.monotonic()
    status, error = None, None
    for _ in range(tries):
        error = None
        try:
            with urllib.request.urlopen(url.rstrip("/") + path, timeout=10) as res:
                status = res.status
        except urllib.error.HTTPError as e:
            status = e.code
        except Exception as e:  # 연결 실패, 타임아웃
            status, error = None, str(e)
        if status == 200:
            break
        if status is not None and status < 500:   # 404 같은 확실한 실패는 다시 시도하지 않음
            break
        time.sleep(2)
    passed = status == 200
    return {"target": target, "mode": "candidate", "pass": passed, "url": url,
            "checker": "temporary-http-200",
            "checks": [{"name": "http_200", "pass": passed, "status": status,
                        "ms": int((time.monotonic() - started) * 1000), "error": error}]}


def main():
    args = parse_args()
    result = {"run_id": None, "digest": None, "image": None, "decision": "error",
              "signature": None, "targets": [], "checks": [],
              "options": {"migration": args.migration, "pii_possible": args.pii_possible},
              "started_at": now()}
    try:
        sign = load_sign_result(args.sign_result)
        result["run_id"], result["digest"] = sign["run_id"], sign["digest"]
        image_ref, key = verify_signature(sign)
        result["image"] = image_ref
        result["signature"] = {"verified": True, "ref": sign["signature_ref"], "key": key}
        log(f"run_id={sign['run_id']} targets={sign['targets']}")

        # 1) 후보 배포
        candidates = {}
        for target in [t for t in KNOWN_TARGETS if t in sign["targets"]]:
            if target == "cloud_run":
                r = cloudrun_candidate(image_ref, sign["run_id"])
            else:
                r = onprem_candidate(image_ref, sign["run_id"])
            result["targets"].append(r)
            if r["result"] == "ok":
                candidates[target] = r
        if not candidates:
            raise RuntimeError("후보를 띄운 대상이 없음")

        # 2) 검사
        result["checks"] = [run_check(t, r["candidate_url"]) for t, r in candidates.items()]

        # 3) 판단과 전환
        if all(c["pass"] for c in result["checks"]):
            done = []
            try:
                if "cloud_run" in candidates:
                    a = cloudrun_activate()
                    result["targets"].append(a)
                    done.append(a)
                # 온프레 전환 자리 (작업함 activate)
                result["decision"] = "activated"
            except Exception as e:
                log(f"전환 실패, 이미 전환한 대상을 되돌림: {e}")
                for a in done:
                    if a["target"] == "cloud_run" and a.get("previous"):
                        result["targets"].append(cloudrun_rollback(a["previous"]))
                result["decision"] = "rolled_back" if done else "error"
                result["error"] = str(e)
        else:
            log("검사 실패: 전환하지 않고 기존 버전 유지")
            if "cloud_run" in candidates:
                result["targets"].append(cloudrun_discard())
            result["decision"] = "held"
    except Reject as e:
        log(f"배포 거부: {e}")
        result["error"] = str(e)
    except Exception as e:
        log(f"오류: {e}")
        result["error"] = str(e)

    result["finished_at"] = now()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "deploy_result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    return EXIT_CODE.get(result["decision"], 1)


if __name__ == "__main__":
    sys.exit(main())
