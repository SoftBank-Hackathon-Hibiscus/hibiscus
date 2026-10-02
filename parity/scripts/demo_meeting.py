"""회의용 기본 CLI 데모: 기록 -> 노이즈 2회 -> none/restart/replace -> 같은 기준 재검사.

사용자가 직접 실행할 때만 Docker와 Python 자식 프로세스를 실행합니다.
  python scripts/demo_meeting.py

의도된 방명록 결함을 20/20, 14/20, 13/20으로 두 번 검출하면 종료 코드 0입니다.
이는 데모 기대값을 확인했다는 뜻이며 앱은 passed=false입니다. AI 수정이나 정책/서명/
배포 연동을 실행하지 않습니다. 같은 이미지의 반복 시험을 AI 수정 후 재검증으로 표시하지 않습니다.
새 실행 전용 컨테이너만 만들고 정리하며, 빌드한 이미지와 원본 결과 파일은 남깁니다.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[1]
LABEL = "parity.meeting.run"
EXPECTED = {
    "none": (20, []),
    "restart": (14, [11, 12, 13, 14, 17, 20]),
    "replace": (13, [11, 12, 13, 14, 16, 17, 20]),
}


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def file_hash(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def free_local_ports():
    # Hold both sockets while selecting so the proxy and target cannot get the same port.
    first, second = socket.socket(), socket.socket()
    try:
        first.bind(("127.0.0.1", 0))
        second.bind(("127.0.0.1", 0))
        return first.getsockname()[1], second.getsockname()[1]
    finally:
        first.close()
        second.close()
    # Docker gets an explicit fixed port for the whole run. A concurrent port claim makes
    # startup fail; the script does not kill or reuse the process that claimed it.


class DemoCommands:
    def __init__(self, run_dir):
        self.log_path = run_dir / "commands.log"
        self.env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")

    def run(self, args, *, allowed=(0,), timeout=180):
        with self.log_path.open("a", encoding="utf-8") as log:
            log.write("\n$ " + subprocess.list2cmdline([str(arg) for arg in args]) + "\n")
            log.flush()
            completed = subprocess.run([str(arg) for arg in args], cwd=ROOT, env=self.env,
                                       capture_output=True, text=True, encoding="utf-8",
                                       errors="replace", timeout=timeout)
            log.write(completed.stdout)
            log.write(completed.stderr)
            log.write(f"\nexit={completed.returncode}\n")
        if completed.returncode not in allowed:
            raise RuntimeError(f"명령 실행 실패 (exit {completed.returncode}); commands.log를 확인하세요")
        return completed

    def docker(self, *args, **kwargs):
        return self.run(["docker", *args], **kwargs)

    def inspect_container(self, name, missing_ok=False):
        result = self.docker("inspect", "--type", "container", name, allowed=(0, 1), timeout=30)
        if result.returncode:
            if missing_ok and any(text in result.stderr.lower() for text in ("no such container", "no such object")):
                return None
            raise RuntimeError("컨테이너를 확인하지 못했습니다. 다른 컨테이너를 정리하지 않습니다")
        objects = json.loads(result.stdout)
        if not isinstance(objects, list) or len(objects) != 1:
            raise RuntimeError("컨테이너 조회 결과가 한 개가 아닙니다")
        return objects[0]

    def owned(self, name, run_id, image_id=None, missing_ok=False):
        info = self.inspect_container(name, missing_ok=missing_ok)
        if info is None:
            return None
        labels = info.get("Config", {}).get("Labels") or {}
        if info.get("Name") != "/" + name or labels.get(LABEL) != run_id:
            raise RuntimeError("컨테이너 이름/실행 소유권 라벨이 다릅니다. 조작을 중단합니다")
        if image_id is not None and info.get("Image") != image_id:
            raise RuntimeError("컨테이너 이미지가 이번에 빌드한 로컬 이미지 ID와 다릅니다")
        return info

    def remove_owned(self, name, run_id):
        info = self.owned(name, run_id, missing_ok=True)
        if info is not None:
            # Resolve the verified name to an immutable container ID before removal.
            self.docker("rm", "-f", info["Id"], timeout=60)


def baseline_same(paths, hashes):
    try:
        return all(file_hash(path) == hashes[path.name] for path in paths)
    except OSError:
        return False


def inspect_demo_result(result):
    """Check the intentionally failing sample; never rewrite raw result or facts."""
    entries, mismatches = result.get("replay", []), result.get("mismatches", [])
    ok = (result.get("stage") == "test" and result.get("passed") is False
          and isinstance(entries, list) and isinstance(mismatches, list)
          and [entry.get("condition") for entry in entries] == list(EXPECTED))
    summaries = []
    for entry in entries:
        name = entry.get("condition")
        expected_match, expected_indices = EXPECTED.get(name, (None, None))
        actual_indices = [mismatch.get("index") for mismatch in mismatches if mismatch.get("condition") == name]
        condition_ok = (type(entry.get("total")) is int and entry["total"] == 20
                        and type(entry.get("matched")) is int and entry["matched"] == expected_match
                        and "error" not in entry and actual_indices == expected_indices)
        ok = ok and condition_ok
        summaries.append({"condition": name, "total": entry.get("total"), "matched": entry.get("matched"),
                          "mismatch_indices": actual_indices, "expectation_met": bool(condition_ok)})
    ok = ok and len(mismatches) == sum(len(indices) for _, indices in EXPECTED.values())
    return bool(ok), summaries


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "records" / "meeting",
                        help="실행별 하위 폴더를 만들 위치 (기본 records/meeting)")
    args = parser.parse_args(argv)

    run_id = "meeting-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:10]
    run_dir = args.out_dir.resolve() / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    commands = DemoCommands(run_dir)
    container, image_tag = "parity-" + run_id, "parity-meeting:" + run_id
    session_path, noise_path = run_dir / "session.jsonl", run_dir / "session.noise.json"
    baseline_paths = (session_path, noise_path)
    image_id, attempted_container = None, False
    report = {
        "format": "parity-default-cli-meeting-demo-v1",
        "run_id": run_id,
        "pipeline": "python -m parity record -> noise -> test (twice)",
        "conditions": list(EXPECTED),
        "fault_after_request": 10,
        "expected_requests_per_condition": 20,
        "app_passed": None,
        "demo_expectations_met": False,
        "repeatable": False,
        "repeatability_scope": "Condition totals, matched counts, mismatch request indices, and original facts; "
                               "raw timestamps in mismatch previews may differ between runs.",
        "baseline_unchanged": False,
        "registry_digest": None,
        "source_revision": None,
        "image_provenance_note": "local_image_id is a Docker-local image ID, not a registry digest. "
                                 "No registry upload, signature, or source-commit attestation is performed.",
        "ai_repair_performed": False,
        "policy_contract_validated": False,
        "ready_for_signing": False,
        "attempts": [],
        "cleanup": {"completed": False, "image_kept": True},
    }
    failed = None
    try:
        print("[1/6] 방명록 이미지를 한 번 빌드합니다.", flush=True)
        commands.docker("info", "--format", "{{.ServerVersion}}", timeout=30)
        commands.docker("build", "--quiet", "--label", f"{LABEL}={run_id}",
                        "--iidfile", str(run_dir / "image.id"), "--tag", image_tag,
                        str(ROOT.parent / "sample-app"), timeout=600)
        image_id = (run_dir / "image.id").read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
            raise RuntimeError("빌드 결과의 로컬 이미지 ID 형식이 잘못되었습니다")
        image_info = json.loads(commands.docker("image", "inspect", image_id, timeout=30).stdout)[0]
        if image_info.get("Id") != image_id:
            raise RuntimeError("빌드한 이미지 ID를 확인하지 못했습니다")
        report.update(local_image_id=image_id, image_tag=image_tag)

        target_port, proxy_port = free_local_ports()
        target = f"http://127.0.0.1:{target_port}"
        proxy = f"127.0.0.1:{proxy_port}"
        if commands.inspect_container(container, missing_ok=True) is not None:
            raise RuntimeError("이번 실행 이름의 컨테이너가 이미 있습니다. 기존 컨테이너를 사용하지 않습니다")
        attempted_container = True
        commands.docker("run", "--detach", "--name", container, "--label", f"{LABEL}={run_id}",
                        "--publish", f"127.0.0.1:{target_port}:8080", image_id, timeout=60)
        commands.owned(container, run_id, image_id)
        report["target"] = target

        print("[2/6] 사용 흐름 20개를 실제 프록시를 통해 기록합니다.", flush=True)
        commands.run([sys.executable, "-m", "parity", "record", "--target", target,
                      "--listen", proxy, "--out", str(session_path), "--", sys.executable,
                      str(ROOT / "scripts" / "simulate_usage.py"), "--base", "http://" + proxy])
        records = [json.loads(line) for line in session_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if len(records) != 20 or [record.get("index") for record in records] != list(range(1, 21)):
            raise RuntimeError("예상한 순서의 요청 20개가 기록되지 않았습니다")
        recorded_session_sha256 = file_hash(session_path)

        print("[3/6] 초기 상태에서 두 번 재생해 노이즈 규칙을 만듭니다.", flush=True)
        commands.owned(container, run_id, image_id)
        commands.run([sys.executable, "-m", "parity", "noise", "--record", str(session_path),
                      "--target", target, "--container", container, "--runs", "2", "--out", str(noise_path)])
        commands.owned(container, run_id, image_id)
        if file_hash(session_path) != recorded_session_sha256:
            raise RuntimeError("노이즈 탐지 중 원본 사용 기록이 변경되었습니다")
        hashes = {path.name: file_hash(path) for path in baseline_paths}
        report["baseline_sha256"] = hashes
        summaries = []
        for number, result_name in ((1, "result.json"), (2, "repeat_result.json")):
            print(f"[{3 + number}/6] 같은 이미지·기록으로 조건 시험 {number}회차를 실행합니다.", flush=True)
            if not baseline_same(baseline_paths, hashes):
                raise RuntimeError("재검사 전에 기준 기록 또는 노이즈 파일이 변경되었습니다")
            commands.owned(container, run_id, image_id)
            result_path = run_dir / result_name
            completed = commands.run([
                sys.executable, "-m", "parity", "test", "--record", str(session_path),
                "--noise", str(noise_path), "--target", target, "--container", container,
                "--conditions", "none,restart,replace", "--restart-after", "10",
                "--expected-image-id", image_id, "--out", str(result_path),
            ], allowed=(0, 1), timeout=300)
            commands.owned(container, run_id, image_id)
            result = json.loads(result_path.read_text(encoding="utf-8"))
            demo_ok, summary = inspect_demo_result(result)
            demo_ok = demo_ok and completed.returncode == 1
            unchanged = baseline_same(baseline_paths, hashes)
            attempt = {"number": number, "result": result_name, "result_sha256": file_hash(result_path),
                       "cli_exit_code": completed.returncode, "app_passed": result.get("passed"),
                       "demo_expectations_met": bool(demo_ok and unchanged),
                       "baseline_unchanged": unchanged, "conditions": summary,
                       "facts": result.get("facts")}
            diagnostics_path = result_path.with_name(result_path.stem + ".diagnostics.json")
            if diagnostics_path.is_file():
                attempt["diagnostics"] = diagnostics_path.name
                attempt["diagnostics_sha256"] = file_hash(diagnostics_path)
            report["attempts"].append(attempt)
            summaries.append(summary)
            print(completed.stdout.strip(), flush=True)
            if not unchanged:
                raise RuntimeError("검사 중 기준 기록 또는 노이즈 파일이 변경되었습니다")
        report["app_passed"] = all(attempt["app_passed"] is True for attempt in report["attempts"])
        report["baseline_unchanged"] = baseline_same(baseline_paths, hashes)
        report["repeatable"] = (summaries[0] == summaries[1]
                                and report["attempts"][0]["facts"] == report["attempts"][1]["facts"])
        report["demo_expectations_met"] = (report["baseline_unchanged"] and report["repeatable"]
                                           and all(attempt["demo_expectations_met"] for attempt in report["attempts"]))
        print("[6/6] 실행 소유권을 확인한 데모 컨테이너만 정리합니다.", flush=True)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        failed = f"{type(exc).__name__}: {exc}"
        report["error"] = failed
        report["demo_expectations_met"] = False
    finally:
        try:
            if attempted_container:
                commands.remove_owned(container, run_id)
            report["cleanup"]["completed"] = True
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            report["cleanup"]["error"] = f"{type(exc).__name__}: {exc}"
            report["demo_expectations_met"] = False
            failed = failed or report["cleanup"]["error"]
        save_json(run_dir / "demo_report.json", report)

    print("\n앱 검사 통과: " + str(report["app_passed"]).lower())
    print("의도된 결함 검출 + 반복 시험 기대값 충족: " + str(report["demo_expectations_met"]).lower())
    print("같은 이미지·기록 반복 시험이며, AI 수정 시험은 수행하지 않았습니다.")
    print("원본 결과와 실행 로그: " + str(run_dir))
    print("보고서: " + str(run_dir / "demo_report.json"))
    if failed:
        print("실행 오류: " + failed, file=sys.stderr)
        return 2
    return 0 if report["demo_expectations_met"] else 1


if __name__ == "__main__":
    sys.exit(main())
