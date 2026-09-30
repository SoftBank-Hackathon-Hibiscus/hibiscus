"""기본 설정. 값의 의미는 IMPLEMENTATION_SPEC 5절 표를 따른다."""

from dataclasses import dataclass
from pathlib import Path

CORE_CONDITIONS = ("none", "restart", "replace")

OWNER_LABEL_KEY = "premortem.owner"
OWNER_LABEL_VALUE = "juyeong"
RUN_LABEL_KEY = "premortem.run_id"
CONDITION_LABEL_KEY = "premortem.condition"


@dataclass(frozen=True)
class Settings:
    run_root: Path = Path(__file__).resolve().parent / ".runs"  # 실행 결과. 커밋하지 않는다
    default_profile: str = "core"
    request_timeout_sec: float = 5.0
    ready_timeout_sec: float = 30.0
    docker_command_timeout_sec: float = 60.0
    build_timeout_sec: float = 300.0
    max_requests: int = 200
    max_body_bytes: int = 1_048_576
    max_evidence_bytes: int = 2_097_152
    max_patch_files: int = 5
    max_patch_changed_lines: int = 200
    max_patch_bytes: int = 32_768
    max_ai_calls: int = 2
    max_repair_rounds: int = 1
    min_patch_confidence: float = 0.8
    ai_mode: str = "off"
    ai_timeout_sec: float = 120.0
