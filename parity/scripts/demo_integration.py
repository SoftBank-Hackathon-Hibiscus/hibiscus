"""parity 기록을 실제 premortem ConditionRunner에 연결하는 선택적 Docker 데모.

premortem 코드가 있는 폴더를 --premortem-root로 지정한다. 기존 컨테이너를 받지 않고
매번 새 실행 ID와 컨테이너를 사용한다. AI, 정책, 레지스트리 업로드는 실행하지 않는다.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from parity import docker_ops, facts, noise
from parity.premortem_adapter import ParityReplayPort
from parity.record import load_records, start_proxy
from parity.replay import replay


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--premortem-root", type=Path, required=True,
                        help="premortem/ 패키지가 들어 있는 폴더 (PR #4의 parity 폴더)")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "records" / "integration")
    args = parser.parse_args()
    peer = args.premortem_root.resolve()
    if not (peer / "premortem" / "replay_port.py").is_file():
        parser.error("--premortem-root 안에 premortem/replay_port.py가 필요합니다")
    # 전달받은 Python 모듈을 실행하므로 신뢰하는 팀 코드만 지정한다.
    sys.path.insert(1, str(peer))
    from premortem.config import Settings
    from premortem.docker_driver import DockerDriver
    from premortem.evidence import EvidenceLog
    from premortem.lifecycle import ConditionRunner
    from premortem.process import SubprocessRunner
    from premortem.scenarios import Scenario

    run_id = "parity-" + uuid.uuid4().hex[:12]
    run_dir = args.out_dir.resolve() / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    settings = Settings()
    docker = DockerDriver(SubprocessRunner(), settings)
    docker.require_daemon()
    image = "parity-integration:" + run_id
    image_id = docker.build(str(ROOT.parent / "sample-app"), image,
                            {"parity.integration.run": run_id})
    owned, engine = [], None
    session_path, noise_path = run_dir / "session.jsonl", run_dir / "session.noise.json"
    cleanup_failures = []

    def fresh(condition):
        container = docker.create(image_id, run_id, condition, 8080, len(owned) + 1)
        owned.append(container)
        docker.start(container)
        if docker.inspect(container)["image"] != image_id:
            raise RuntimeError("고정한 이미지 ID와 실제 컨테이너 이미지가 다릅니다")
        target = "http://127.0.0.1:" + str(docker.host_port(container, 8080))
        docker_ops.wait_healthy(target + "/healthz", timeout=30)
        return container, target

    try:
        container, target = fresh("record")
        server, recorder = start_proxy("127.0.0.1", 0, target, str(session_path))
        try:
            subprocess.run([sys.executable, str(ROOT / "scripts" / "simulate_usage.py"),
                            "--base", "http://127.0.0.1:" + str(server.server_address[1])],
                           check=True, env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        finally:
            server.shutdown()
            server.server_close()
            recorder.close()
        raw_facts = facts.collect(container)
        save(run_dir / "facts.json", raw_facts)
        docker.remove(container, run_id)
        records = load_records(str(session_path))
        responses = []
        for number in (1, 2):
            container, target = fresh("noise" + str(number))
            result = replay(records, target)
            if result.error or any(r is None or r.error for r in result.responses):
                raise RuntimeError("노이즈 기준 재생이 완료되지 않았습니다")
            responses.append(result.responses)
            docker.remove(container, run_id)
        noise.save(noise.analyze(records, responses), str(noise_path))
        baseline = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (session_path, noise_path)}
        scenario = Scenario("guestbook-parity", "의도된 결함을 가진 팀 방명록",
                            ROOT.parent / "sample-app", session_path, noise_path,
                            8080, "/healthz", 30.0, (10,), ("none", "restart", "replace"), (), {})
        evidence = EvidenceLog(run_id, run_dir, settings.max_evidence_bytes)
        engine = ConditionRunner(docker, evidence, ParityReplayPort(), scenario,
                                 run_id, image_id, len(records))
        conditions = engine.run_all(["none", "restart", "replace"], [10])
        unchanged = all(hashlib.sha256(p.read_bytes()).hexdigest() == baseline[p.name]
                        for p in (session_path, noise_path))
        result = {
            "format": "parity-premortem-integration-demo-v1",
            "run_id": run_id,
            "replay_backend": "parity",
            "local_image_id": image_id,
            "registry_digest": None,
            "source_revision": None,
            "baseline_sha256": baseline,
            "baseline_unchanged": unchanged,
            "passed": unchanged and all(c["status"] == "passed" for c in conditions),
            "facts": raw_facts,
            "facts_observed_at": "recording_container_before_removal",
            "conditions": conditions,
            "policy_contract_validated": False,
            "ready_for_signing": False,
        }
        # 데모의 성공과 앱의 검사 통과는 다르다. 일부러 넣은 결함을 정확히 잡아야 데모 성공.
        expected = {"none": (20, []), "restart": (14, [11, 12, 13, 14, 17, 20]),
                    "replace": (13, [11, 12, 13, 14, 16, 17, 20])}
        demo_ok = unchanged and len(conditions) == 3
        for condition in conditions:
            matched, indices = expected[condition["name"]]
            demo_ok = demo_ok and (
                condition["expected_count"] == condition["executed_count"] == 20
                and condition["matched_count"] == matched
                and condition["status"] == ("passed" if not indices else "failed")
                and [m["request_index"] for m in condition["mismatches"]] == indices)
        result["demo_expectations_met"] = bool(demo_ok)
        save(run_dir / "integration_result.json", result)
        print(", ".join(f"{c['name']}: {c['matched_count']}/{c['expected_count']} ({c['status']})"
                        for c in conditions))
        print("앱 passed=" + str(result["passed"]) + ", 데모 검증=" + str(bool(demo_ok)))
        print("결과: " + str(run_dir / "integration_result.json"))
        return 0 if demo_ok else 1
    finally:
        cleanup_failures = docker.cleanup(owned + (engine.tracked if engine else []), run_id)
        if cleanup_failures:
            # 성공 메시지가 먼저 출력되었더라도 정리 실패를 성공 종료로 감추지 않는다.
            raise RuntimeError("테스트 컨테이너 정리 실패: " + ", ".join(cleanup_failures))


if __name__ == "__main__":
    sys.exit(main())
