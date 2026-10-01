"""한 번의 검사 실행: 기준 고정 → 소스 스냅샷 → 이미지 빌드 → 조건 실행 → 판정 → 결과 파일.

재검증(retest)도 같은 함수를 쓰되 새 run_id·새 스냅샷·새 이미지로 실행하고 parent_run_id로 이어 둔다.
session·noise 기준은 실행 전후 hash가 같아야 하며, 바뀌면 판정을 error로 둔다.
"""

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .config import OWNER_LABEL_KEY, OWNER_LABEL_VALUE, Settings
from .errors import PremortemError
from .evidence import EvidenceLog, utc_now
from .gate import fault_positions, overall_status
from .jsonio import load_jsonl, write_json_atomic
from .lifecycle import ConditionRunner
from .paths import create_run_dir, new_run_id
from .snapshot import copy_file, git_commit_for, sha256_file, take_snapshot, verify_unchanged
from .validation import validate

REFERENCE_BLOCKERS = [
    "재생: reference(개발용 샘플 전용). 윤선님 정식 재생기(guestbook-parity) 미연결",
    "계약: 류진님 contracts와 정식 변환기 미연결. 정책 입력(test_result)을 만들지 않음",
    "이미지: registry digest 없음. 로컬 image ID만 확인",
]
PARITY_BLOCKERS = [
    "계약: 류진님 변환기가 아직 env_report를 읽지 않음. 정책 입력(test_result)을 만들지 않음",
    "이미지: registry digest 없음. 로컬 image ID만 확인",
]


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


@dataclass
class RunResult:
    run_id: str
    run_dir: Path
    manifest: dict
    env_report: dict
    cleanup_failures: list


def execute_run(scenario, source_dir: Path, stage: str, parent_run_id: Optional[str], settings: Settings,
                docker, replay_port, commit_runner, run_root: Optional[Path] = None) -> RunResult:
    run_root = Path(run_root or settings.run_root)
    run_id = new_run_id(f"{scenario.name}-{'pre' if stage == 'pretest' else 'retest'}")
    run_dir = create_run_dir(run_root, run_id)
    log(f"[{run_id}] 시작 ({stage})")

    session_sha = sha256_file(scenario.session_path)
    noise_sha = sha256_file(scenario.noise_path)
    copy_file(scenario.session_path, run_dir / "baseline" / "session.jsonl", session_sha)
    copy_file(scenario.noise_path, run_dir / "baseline" / "noise.json", noise_sha)
    baseline = {"session_path": "baseline/session.jsonl", "session_sha256": session_sha,
                "noise_path": "baseline/noise.json", "noise_sha256": noise_sha}

    snapshot = take_snapshot(source_dir, run_dir / "source")
    source = {"commit": git_commit_for(source_dir, commit_runner), "tree_sha256": snapshot.tree_sha256,
              "excludes": list(snapshot.excludes)}

    team = replay_port.backend == "parity"  # 윤선님 재생기로 실제 앱을 검사하는 실행. 아니면 개발용 샘플
    tag = f"{'premortem' if team else 'premortem-demo'}/{scenario.name}:{snapshot.tree_sha256[:12]}"
    log(f"[{run_id}] 이미지 빌드: {tag}")
    image_id = docker.build(str(snapshot.root), tag, {OWNER_LABEL_KEY: OWNER_LABEL_VALUE,
                                                      "premortem.source_tree_sha256": snapshot.tree_sha256})
    image = {"reference": tag, "local_image_id": image_id, "registry_digest": None,
             "registry_link_verified": False, "source_build_link_verified": True,
             "platform": docker.image_platform(image_id)}

    request_count = len(load_jsonl(scenario.session_path))
    fault_after = fault_positions(list(scenario.fault_after), request_count)
    required = list(scenario.required_conditions)
    manifest = {
        "schema_version": "1.0", "run_id": run_id, "parent_run_id": parent_run_id, "stage": stage,
        "created_at": utc_now(), "execution_mode": "real", "replay_backend": replay_port.backend,
        "source": source, "baseline": baseline, "image": image,
        "settings": {"profile": "core", "required_conditions": required, "fault_after": fault_after,
                     "storage_mode": "ephemeral", "baseline_integrity_verified": True,
                     "seed_descriptor": {"mode": "empty", "reference": None, "sha256": None}},
        "note": (f"{scenario.name} 소스를 이 모듈의 빌더로 빌드해 실제 Docker로 실행. 재생·비교는 윤선님 parity 재생기."
                 if team else
                 f"개발용 샘플({scenario.name})을 이 모듈의 신뢰된 데모 빌더로 빌드해 실제 Docker로 실행. 팀 앱이 아님."),
    }
    validate("run-manifest", manifest)
    write_json_atomic(run_dir / "run_manifest.json", manifest)

    evidence = EvidenceLog(run_id, run_dir, settings.max_evidence_bytes)
    evidence.add("none", "source_identity",
                 f"소스 tree sha256 {snapshot.tree_sha256[:16]}…, 파일 {len(snapshot.files)}개, commit {source['commit'][:12]}")
    evidence.add("none", "baseline_identity", f"session sha256 {session_sha[:16]}…, noise sha256 {noise_sha[:16]}…")
    evidence.add("none", "image_identity",
                 f"{tag} → local image ID {image_id[:19]}…, registry digest 없음(로컬 전용 시험)")

    runner = ConditionRunner(docker, evidence, replay_port, scenario, run_id, image_id, request_count)
    conditions, cleanup_failures = [], []
    try:
        conditions = runner.run_all(required, fault_after)
    finally:
        cleanup_failures = docker.cleanup(runner.tracked, run_id)
        if cleanup_failures:
            log(f"[{run_id}] 정리 실패(CLEANUP_FAILED): " + ", ".join(c[:12] for c in cleanup_failures))

    baseline_ok = True
    try:
        verify_unchanged(scenario.session_path, session_sha)
        verify_unchanged(scenario.noise_path, noise_sha)
    except PremortemError:
        baseline_ok = False
    overall = overall_status(required, conditions) if baseline_ok else "error"
    manifest_blockers = list(PARITY_BLOCKERS if team else REFERENCE_BLOCKERS)
    if overall != "passed":
        manifest_blockers.append(f"판정: {overall}. 필수 조건이 모두 통과하지 않음")
    if not baseline_ok:
        manifest_blockers.append("BASELINE_CHANGED: 실행 중 기준 기록이 바뀜")

    artifacts = [{"role": role, "path": rel, "sha256": sha256_file(run_dir / rel)} for role, rel in (
        ("run_manifest", "run_manifest.json"), ("evidence", "evidence.jsonl"),
        ("session", "baseline/session.jsonl"), ("noise", "baseline/noise.json"))]
    env_report = {
        "schema_version": "1.0", "run_id": run_id, "parent_run_id": parent_run_id, "stage": stage,
        "execution_mode": "real", "replay_backend": replay_port.backend,
        "team_parity_integrated": team, "team_contract_validated": False,
        "baseline_integrity_verified": baseline_ok, "source": source, "baseline": baseline, "image": image,
        "required_conditions": required, "conditions": conditions, "overall_status": overall,
        "gate": {"test_passed": overall == "passed", "handoff_ready": False, "handoff_blockers": manifest_blockers},
        "artifacts": artifacts,
        "note": ("실제 Docker로 실행한 결과. 재생·비교는 윤선님 parity 재생기, 컨테이너 조건과 증거는 이 모듈."
                 if team else
                 "개발용 샘플 앱을 실제 Docker로 실행한 결과. reference 재생기 결과이며 팀 연동 결과가 아님."),
    }
    validate("env-report", env_report)
    write_json_atomic(run_dir / "env_report.json", env_report)
    log(f"[{run_id}] 판정: {overall}")
    return RunResult(run_id, run_dir, manifest, env_report, cleanup_failures)
