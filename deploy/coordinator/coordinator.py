#!/usr/bin/env python3
"""배포 조율기 v0 (준하)

sign_result.json을 받아 대상별 후보 배포 -> 검사 -> 전환(또는 유지)을 실행하고
deploy_result.json을 출력한다.

비어 있는 자리 (태현님과 형식 확정 후 채움)
- 온프레 후보/전환/롤백: onprem_* 함수. 지금은 skipped로 기록만 한다
- 검사: run_check 함수. 지금은 후보 주소가 HTTP 200을 주는지만 보는 임시 검사다
"""
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
CLOUDRUN = HERE.parent / "cloudrun"
OUT_DIR = Path(os.environ.get("OUT_DIR", HERE.parent / "out"))
KNOWN_TARGETS = ("cloud_run", "onprem")          # 전환 순서도 이 순서 (Cloud Run 먼저)
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
EXIT_CODE = {"activated": 0, "held": 3, "rolled_back": 4}


def now():
    return datetime.now(KST).isoformat(timespec="seconds")


def log(msg):
    print(f"[coordinator] {msg}", file=sys.stderr)


def load_sign_result(path):
    data = json.loads(Path(path).read_text())
    for key in ("run_id", "digest", "targets", "failover_allowed"):
        if key not in data:
            raise ValueError(f"sign_result에 {key} 없음")
    if not RUN_ID_RE.match(data["run_id"]):
        raise ValueError(f"run_id 형식 오류: {data['run_id']}")
    if not DIGEST_RE.match(data["digest"]):
        raise ValueError(f"digest 형식 오류: {data['digest']}")
    unknown = [t for t in data["targets"] if t not in KNOWN_TARGETS]
    if unknown:
        raise ValueError(f"알 수 없는 배포 대상: {unknown}")
    return data


def run_script(name, *args):
    """cloudrun 스크립트를 실행하고 마지막 줄 JSON을 돌려준다. gcloud 진행 메시지는 화면에 그대로 보인다"""
    proc = subprocess.run([str(CLOUDRUN / name), *args], stdout=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{name} 실패 (종료 코드 {proc.returncode})")
    return json.loads(proc.stdout.strip().splitlines()[-1])


# ---- Cloud Run (준하) ----
def cloudrun_candidate(image_ref):
    return run_script("candidate.sh", image_ref)


def cloudrun_activate():
    return run_script("activate.sh")


def cloudrun_rollback(revision):
    return run_script("rollback.sh", revision)


def cloudrun_discard():
    return run_script("discard.sh")


# ---- 온프레 (태현님 에이전트 자리. 형식 확정 전이라 호출하지 않는다) ----
def onprem_candidate(image_ref):
    reason = ("ONPREM_AGENT_URL not set" if not os.environ.get("ONPREM_AGENT_URL")
              else "onprem agent API not agreed yet")
    return {"target": "onprem", "phase": "candidate", "result": "skipped", "reason": reason}


# ---- 검사 (임시. 태현님 검사기로 교체 예정) ----
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
        time.sleep(2)
    passed = status == 200
    return {"target": target, "mode": "candidate", "pass": passed, "url": url,
            "checker": "temporary-http-200",
            "checks": [{"name": "http_200", "pass": passed, "status": status,
                        "ms": int((time.monotonic() - started) * 1000), "error": error}]}


def main():
    if len(sys.argv) != 2:
        print("사용: coordinator.py <sign_result.json>", file=sys.stderr)
        return 1

    result = {"run_id": None, "digest": None, "decision": "error",
              "targets": [], "checks": [], "started_at": now()}
    try:
        sign = load_sign_result(sys.argv[1])
        result["run_id"], result["digest"] = sign["run_id"], sign["digest"]
        image_repo = os.environ.get("IMAGE_REPO") or os.environ["IMG"]
        image_ref = f"{image_repo}@{sign['digest']}"
        log(f"run_id={sign['run_id']} targets={sign['targets']}")

        # 1) 후보 배포
        candidates = {}
        for target in [t for t in KNOWN_TARGETS if t in sign["targets"]]:
            r = cloudrun_candidate(image_ref) if target == "cloud_run" else onprem_candidate(image_ref)
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
                # 온프레 전환 자리 (태현님 에이전트 /activate)
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
    except Exception as e:
        log(f"오류: {e}")
        result["error"] = str(e)

    result["finished_at"] = now()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"deploy_result-{result['run_id'] or 'unknown'}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    return EXIT_CODE.get(result["decision"], 1)


if __name__ == "__main__":
    sys.exit(main())
