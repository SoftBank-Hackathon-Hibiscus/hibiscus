"""주영 모듈 내부 재생 인터페이스.

윤선님 코드에 이미 있는 함수 이름이 아니라 이 모듈이 새로 정한 것이다. 팀 재생기를 받으면
adapters/parity_adapter.py가 실제 함수를 이 모양으로 감싼다.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Optional, Protocol

from .errors import PremortemError


@dataclass
class RequestResult:
    request_index: int
    matched: bool
    kind: Optional[str]  # None, "status", "body", "transport"
    summary: str


@dataclass
class ReplayOutcome:
    backend: str  # "reference" 또는 "parity"
    expected_count: int
    executed_count: int
    matched_count: int
    results: list = field(default_factory=list)
    facts: Optional[list] = None  # 팀 재생기가 준 facts 원본. None이면 수집하지 않은 것


class ReplayHookError(PremortemError):
    """요청 사이 훅이 실패했다. 훅 예외는 삼키지 않고 지금까지의 결과와 함께 올린다."""

    def __init__(self, cause: Exception, partial: ReplayOutcome):
        code = cause.code if isinstance(cause, PremortemError) else "HOOK_FAILED"
        message = cause.message if isinstance(cause, PremortemError) else f"{type(cause).__name__}: {cause}"
        super().__init__(code, message)
        self.cause = cause
        self.partial = partial


class ReplayPort(Protocol):
    backend: str

    def replay(
        self,
        session_path: Path,
        noise_path: Path,
        target_for_request: Callable[[int], str],
        after_response: Callable[[int], None],
        runtime_secrets: Mapping[str, str],
    ) -> ReplayOutcome:
        """요청을 1번부터 순서대로 보낸다. after_response(i)는 i번 응답을 비교·기록한 뒤,
        i+1번 요청을 보내기 전에 호출한다. 비교 규칙은 target이 바뀌어도 같다."""
        ...
