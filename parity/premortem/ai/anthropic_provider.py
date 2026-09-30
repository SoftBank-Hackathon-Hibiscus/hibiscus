"""실제 AI 호출: Anthropic Messages API (IMPLEMENTATION_SPEC 13.2).

팀 코드에 있는 LLM 연결(류진님 개인정보 판정)이 Anthropic이라 키를 하나로 쓰기 쉽도록 맞췄다.
- 도구는 주지 않고 구조화 출력(output_config.format)으로 JSON만 받는다.
- 명시적 --ai live에서만 부른다. 키와 모델(PREMORTEM_LLM_MODEL)이 없으면 호출하지 않는다.
- SDK 재시도를 1회로 묶어 한 번 실행에 최대 2회만 호출한다.
- 거절 시 서버가 다른 모델로 다시 시도할 수 있으므로(fallbacks) 실제로 응답한 모델을 기록한다.
- 키 값은 어디에도 기록하지 않는다.
"""

import os
import time
from typing import Optional

from ..errors import PremortemError
from ..jsonio import loads_strict
from .provider import AnalysisResult

MAX_TOKENS = 16000
EFFORT = "high"


def map_api_error(error: Exception) -> Optional[str]:
    """SDK 예외를 오류 코드로 바꾼다. API 오류로 보이지 않으면 None(프로그램 버그로 그대로 올린다)."""
    status = getattr(error, "status_code", None)
    name = type(error).__name__
    if status in (401, 403):
        return "AI_AUTH_FAILED"
    if status == 404:
        return "AI_MODEL_INVALID"
    if status in (400, 413, 422):
        return "AI_REQUEST_INVALID"
    if "Timeout" in name:
        return "AI_TIMEOUT"
    if status == 429 or (isinstance(status, int) and status >= 500) or "Connection" in name:
        return "AI_UNAVAILABLE"
    if isinstance(status, int):
        return "AI_UNAVAILABLE"
    return None


class AnthropicMessagesProvider:
    name = "anthropic_messages"

    def __init__(self, model: str, client, clock=time.monotonic):
        self.model = model
        self.client = client
        self.clock = clock

    @classmethod
    def from_environment(cls, timeout_sec: float = 120.0) -> "AnthropicMessagesProvider":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise PremortemError("AI_CREDENTIALS_MISSING", "ANTHROPIC_API_KEY가 없어 live AI를 부르지 않음")
        model = os.environ.get("PREMORTEM_LLM_MODEL")
        if not model:
            raise PremortemError("AI_MODEL_MISSING", "PREMORTEM_LLM_MODEL이 없어 live AI를 부르지 않음")
        try:
            import anthropic
        except ImportError:
            raise PremortemError("AI_PROVIDER_UNAVAILABLE", "anthropic SDK가 설치되지 않음(pip install anthropic)") from None
        return cls(model, anthropic.Anthropic(timeout=timeout_sec, max_retries=1))

    def _failed(self, status: str, code: str, start: float, **extra) -> AnalysisResult:
        return AnalysisResult(self.name, extra.pop("model", self.model), status, None,
                              duration_ms=int((self.clock() - start) * 1000), error_code=code, **extra)

    def analyze(self, system_prompt: str, payload_json: str, api_schema: dict) -> AnalysisResult:
        start = self.clock()
        try:
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                system=system_prompt,
                messages=[{"role": "user", "content": payload_json}],
                output_config={"format": {"type": "json_schema", "schema": api_schema}, "effort": EFFORT},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except Exception as error:
            code = map_api_error(error)
            if code is None:
                raise
            return self._failed("error", code, start)

        served_model = getattr(response, "model", None) or self.model
        request_id = getattr(response, "_request_id", None)
        usage_obj = getattr(response, "usage", None)
        usage = {"input_tokens": getattr(usage_obj, "input_tokens", None),
                 "output_tokens": getattr(usage_obj, "output_tokens", None), "cost": None, "currency": None}
        stop = getattr(response, "stop_reason", None)
        if stop == "refusal":
            category = getattr(getattr(response, "stop_details", None), "category", None)
            return self._failed("refused", "AI_REFUSED", start, model=served_model, usage=usage,
                                request_id=request_id, stop_category=category)
        if stop == "max_tokens":
            return self._failed("incomplete", "AI_INCOMPLETE", start, model=served_model, usage=usage, request_id=request_id)
        if stop != "end_turn":
            return self._failed("invalid", "AI_INVALID_OUTPUT", start, model=served_model, usage=usage, request_id=request_id)
        text = "".join(getattr(block, "text", "") for block in getattr(response, "content", [])
                       if getattr(block, "type", None) == "text")
        try:
            output = loads_strict(text)
        except PremortemError:
            return self._failed("invalid", "AI_INVALID_OUTPUT", start, model=served_model, usage=usage, request_id=request_id)
        if not isinstance(output, dict):
            return self._failed("invalid", "AI_INVALID_OUTPUT", start, model=served_model, usage=usage, request_id=request_id)
        return AnalysisResult(self.name, served_model, "succeeded", output,
                              duration_ms=int((self.clock() - start) * 1000), usage=usage, request_id=request_id,
                              note=f"실제 AI 호출({served_model})")
