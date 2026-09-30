"""AI provider 공통 모양. provider는 도구 없이 JSON 분석 결과만 돌려준다.

provider 값: fixture·supplied_json(실제 호출 아님), anthropic_messages(실제 호출), recorded_live(이전 실제 호출의 녹화 재생)
"""

from dataclasses import dataclass, field
from typing import Optional, Protocol

LIVE_PROVIDERS = ("anthropic_messages", "openai_responses", "team")


@dataclass
class AnalysisResult:
    provider: str
    model: Optional[str]
    status: str  # succeeded, refused, incomplete, invalid, error
    output: Optional[dict]
    duration_ms: int = 0
    usage: dict = field(default_factory=lambda: {"input_tokens": None, "output_tokens": None, "cost": None, "currency": None})
    error_code: Optional[str] = None
    request_id: Optional[str] = None
    stop_category: Optional[str] = None
    recorded_from: Optional[dict] = None
    note: str = ""


class AnalysisProvider(Protocol):
    name: str

    def analyze(self, system_prompt: str, payload_json: str, api_schema: dict) -> AnalysisResult: ...
