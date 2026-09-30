"""실제 AI를 부르지 않는 provider 세 가지.

- FixtureProvider: 합성 예시 응답(examples/premortem/fixtures). 실제 AI 호출로 표시하지 않는다.
- JsonFileProvider: 사람이 준 JSON(supplied_json). 역시 실제 AI 호출이 아니다.
- RecordedProvider: 이전에 실제로 호출해서 저장한 analysis.json을 다시 쓴다(recorded_live).
  실제 호출 기록만 받고, 출력은 이번 실행의 입력으로 다시 검증된다(analyzer가 한다).
"""

import time
from pathlib import Path

from ..errors import PremortemError
from ..jsonio import load_json
from ..snapshot import sha256_file
from .provider import LIVE_PROVIDERS, AnalysisResult

FIXTURES = Path(__file__).resolve().parents[2] / "examples" / "premortem" / "fixtures"


class FixtureProvider:
    name = "fixture"

    def __init__(self, scenario: str, fixtures_dir: Path = FIXTURES):
        self.path = Path(fixtures_dir) / f"{scenario}-analysis.fixture.json"

    def analyze(self, system_prompt: str, payload_json: str, api_schema: dict) -> AnalysisResult:
        if not self.path.is_file():
            raise PremortemError("AI_FIXTURE_MISSING", f"합성 예시 응답이 없음: {self.path.name}")
        data = load_json(self.path)
        if data.get("fixture") is not True or not isinstance(data.get("output"), dict):
            raise PremortemError("AI_FIXTURE_MISSING", "fixture 파일에는 fixture: true와 output이 있어야 함")
        return AnalysisResult("fixture", None, "succeeded", data["output"],
                              note="합성 예시 응답. 실제 AI 호출이 아님")


class JsonFileProvider:
    name = "supplied_json"

    def __init__(self, path: Path):
        self.path = Path(path)

    def analyze(self, system_prompt: str, payload_json: str, api_schema: dict) -> AnalysisResult:
        data = load_json(self.path)
        output = data.get("output") if isinstance(data, dict) and "output" in data else data
        if not isinstance(output, dict):
            raise PremortemError("AI_INVALID_OUTPUT", "json-file에는 분석 결과 객체가 있어야 함")
        return AnalysisResult("supplied_json", None, "succeeded", output,
                              note="사람이 준 JSON. 실제 AI 호출이 아님")


class RecordedProvider:
    name = "recorded_live"

    def __init__(self, path: Path, clock=time.monotonic):
        self.path = Path(path)
        self.clock = clock

    def analyze(self, system_prompt: str, payload_json: str, api_schema: dict) -> AnalysisResult:
        start = self.clock()
        record = load_json(self.path)
        if not isinstance(record, dict) or record.get("provider") not in LIVE_PROVIDERS:
            raise PremortemError("AI_RECORDING_INVALID",
                                 "실제 live 호출로 저장한 analysis.json만 재생할 수 있음(fixture·supplied_json·녹화본은 거부)")
        if record.get("status") != "succeeded" or not isinstance(record.get("output"), dict):
            raise PremortemError("AI_RECORDING_INVALID", "성공한 호출 기록만 재생할 수 있음")
        origin = {"run_id": record["run_id"], "analysis_sha256": sha256_file(self.path),
                  "provider": record["provider"], "model": record.get("model") or "unknown",
                  "created_at": record["created_at"]}
        return AnalysisResult("recorded_live", record.get("model"), "succeeded", record["output"],
                              duration_ms=int((self.clock() - start) * 1000), recorded_from=origin,
                              note=f"녹화된 실제 응답({origin['created_at']}, {origin['model']}). 이번 실행에서 AI 호출 없음")
