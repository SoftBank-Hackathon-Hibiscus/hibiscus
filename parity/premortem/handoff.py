"""정책 파트로 넘길 묶음(handoff_bundle.json).

팀 연동 전에는 mode=pending_team_integration, ready_for_policy=false로만 만든다. 정식 정책 입력이 아니다.
받는 쪽은 파일 경로와 sha256으로 무결성을 확인한다.
"""

from pathlib import Path

from .errors import PremortemError
from .jsonio import load_json, write_json_atomic
from .paths import resolve_inside
from .snapshot import sha256_file
from .validation import validate

_CANDIDATES = (
    ("env_report", "env_report.json"), ("run_manifest", "run_manifest.json"), ("evidence", "evidence.jsonl"),
    ("session", "baseline/session.jsonl"), ("noise", "baseline/noise.json"), ("report", "report.md"),
    ("analysis", "analysis.json"), ("patch", "patch.diff"), ("review", "review.md"),
)


def write_handoff(run_dir: Path) -> dict:
    run_dir = Path(run_dir)
    report = load_json(run_dir / "env_report.json")
    artifacts = [{"role": role, "path": rel, "sha256": sha256_file(run_dir / rel)}
                 for role, rel in _CANDIDATES if (run_dir / rel).is_file()]
    bundle = {
        "schema_version": "1.0", "run_id": report["run_id"], "mode": "pending_team_integration",
        "ready_for_policy": False, "blockers": list(report["gate"]["handoff_blockers"]),
        "artifacts": artifacts,
        "note": "주영 모듈의 제안 형식. 류진님 정식 변환기와 contracts가 연결되기 전에는 정책 입력으로 쓰지 않는다.",
    }
    validate("handoff-bundle", bundle)
    write_json_atomic(run_dir / "handoff_bundle.json", bundle)
    return bundle


def verify_handoff(run_dir: Path) -> dict:
    """묶음의 파일이 모두 있고 hash가 맞는지 확인한다. 하나라도 다르면 인계 실패."""
    run_dir = Path(run_dir)
    bundle = load_json(run_dir / "handoff_bundle.json")
    validate("handoff-bundle", bundle)
    for item in bundle["artifacts"]:
        path = resolve_inside(run_dir, item["path"])
        if not path.is_file() or sha256_file(path) != item["sha256"]:
            raise PremortemError("HANDOFF_INVALID", f"인계 파일이 없거나 hash가 다름: {item['path']}")
    return bundle
