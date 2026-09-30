"""개발용 샘플 시나리오. 실제 팀 앱이 아니다(examples/premortem/README.md)."""

from dataclasses import dataclass
from pathlib import Path

from .config import CORE_CONDITIONS
from .errors import PremortemError

SAMPLES_ROOT = Path(__file__).resolve().parents[1] / "examples" / "premortem"


@dataclass(frozen=True)
class Scenario:
    name: str
    description: str
    app_dir: Path
    session_path: Path
    noise_path: Path
    container_port: int
    readiness_path: str
    readiness_timeout_sec: float
    fault_after: tuple
    required_conditions: tuple
    allowed_edit_paths: tuple
    expected_pretest: dict  # 설계상 기대값. 실측 결과가 아니다


def _scenario(name, description, port, readiness_timeout, fault_after, expected) -> Scenario:
    root = SAMPLES_ROOT / name
    return Scenario(name, description, root / "app", root / "baseline" / "session.jsonl", root / "baseline" / "noise.json",
                    port, "/health", readiness_timeout, fault_after, CORE_CONDITIONS, ("app.py",), expected)


SCENARIOS = {
    "state-loss": _scenario("state-loss", "SQLite를 컨테이너 안에 저장하는 메모 앱. 6건 기록, 3번 뒤 조건 주입",
                            8000, 30.0, (3,), {"none": "passed", "restart": "passed", "replace": "failed"}),
    # 원본은 외부 준비 확인이 끝까지 실패하므로 시연이 멈춘 것처럼 보이지 않게 대기를 짧게 둔다. 판정 규칙은 같다.
    "binding": _scenario("binding", "127.0.0.1에만 열리는 health 앱. 4건 기록, 2번 뒤 조건 주입",
                         8080, 8.0, (2,), {"none": "failed", "restart": "skipped", "replace": "skipped"}),
}


def get_scenario(name: str) -> Scenario:
    try:
        return SCENARIOS[name]
    except KeyError:
        raise PremortemError("INPUT_INVALID", f"모르는 시나리오: {name} (가능: {', '.join(SCENARIOS)})") from None
