"""샘플 전용 reference 재생기. 윤선님 정식 재생기를 대신하지 않는다.

examples/premortem 안의 개발용 샘플 기록만 받는다. 상태코드와 JSON 본문을 순서대로 비교하며,
노이즈 탐지는 하지 않는다(샘플에는 실행마다 바뀌는 값이 없다). 결과에는 backend=reference가 붙고
팀 연동 결과로 쓰지 않는다.
"""

import copy
import http.client
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from ..errors import PremortemError
from ..jsonio import load_json, load_jsonl
from ..replay_port import ReplayHookError, ReplayOutcome, RequestResult

SAMPLES_ROOT = Path(__file__).resolve().parents[2] / "examples" / "premortem"
ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}


@dataclass(frozen=True)
class RecordedRequest:
    index: int
    method: str
    path: str
    headers: dict
    body: Any
    expected_status: int
    expected_body: Any


def load_session(path: Path, max_requests: int) -> list:
    rows = load_jsonl(path)
    if len(rows) > max_requests:
        raise PremortemError("INPUT_INVALID", f"기록이 {len(rows)}건으로 상한 {max_requests}건을 넘음")
    requests = []
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict) or row.get("request_index") != position:
            raise PremortemError("INPUT_INVALID", f"요청 번호는 1부터 빠짐없이 이어져야 함 (위치 {position})")
        method, target = row.get("method"), row.get("path")
        expected = row.get("expected") or {}
        if method not in ALLOWED_METHODS:
            raise PremortemError("INPUT_INVALID", f"{position}번 요청의 method를 허용하지 않음: {method}")
        if not isinstance(target, str) or not target.startswith("/") or target.startswith("//") or "\\" in target:
            raise PremortemError("INPUT_INVALID", f"{position}번 요청의 path는 /로 시작하는 상대 경로여야 함")
        headers = row.get("request_headers") or {}
        if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
            raise PremortemError("INPUT_INVALID", f"{position}번 요청의 헤더 형식이 잘못됨")
        if not isinstance(expected.get("status"), int):
            raise PremortemError("INPUT_INVALID", f"{position}번 요청에 기대 상태코드가 없음")
        requests.append(RecordedRequest(position, method, target, headers, row.get("request_body"),
                                        expected["status"], expected.get("body")))
    return requests


def load_noise(path: Path) -> list:
    data = load_json(path)
    pointers = data.get("ignored_json_pointers") if isinstance(data, dict) else None
    if not isinstance(pointers, list) or not all(isinstance(p, str) and p.startswith("/") for p in pointers):
        raise PremortemError("INPUT_INVALID", "noise.json의 ignored_json_pointers는 /로 시작하는 문자열 목록이어야 함")
    return pointers


def _without_pointers(doc: Any, pointers: list) -> Any:
    doc = copy.deepcopy(doc)
    for pointer in pointers:
        parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]]
        parent = doc
        for part in parts[:-1]:
            parent = parent.get(part) if isinstance(parent, dict) else (
                parent[int(part)] if isinstance(parent, list) and part.isdigit() and int(part) < len(parent) else None)
            if parent is None:
                break
        else:
            last = parts[-1] if parts else None
            if isinstance(parent, dict) and last in parent:
                del parent[last]
    return doc


def _preview(value: Any, limit: int = 80) -> str:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return text if len(text) <= limit else text[: limit - 1] + "…"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # 리다이렉트는 따라가지 않고 응답 그대로 비교한다


def check_local_target(base_url: str) -> None:
    """로컬 데모는 이번 실행이 연 루프백 포트만 허용한다."""
    parsed = urllib.parse.urlsplit(base_url)
    try:
        port = parsed.port
    except ValueError:
        port = None
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not port or parsed.path not in ("", "/"):
        raise PremortemError("TARGET_DENIED", f"reference 재생은 http://127.0.0.1:<port>만 허용함: {base_url}")


class ReferenceReplayPort:
    backend = "reference"

    def __init__(self, request_timeout: float = 5.0, max_body_bytes: int = 1_048_576,
                 max_requests: int = 200, samples_root: Path = SAMPLES_ROOT):
        self.request_timeout = request_timeout
        self.max_body_bytes = max_body_bytes
        self.max_requests = max_requests
        self.samples_root = Path(samples_root).resolve()

    def _require_sample(self, path: Path) -> None:
        if not Path(path).resolve().is_relative_to(self.samples_root):
            raise PremortemError("PARITY_ADAPTER_MISSING",
                                 "reference 재생기는 examples/premortem의 개발용 샘플만 받음. "
                                 "실제 앱 기록은 윤선님 재생기 연결이 필요함")

    def replay(self, session_path: Path, noise_path: Path, target_for_request: Callable[[int], str],
               after_response: Callable[[int], None], runtime_secrets: Mapping[str, str]) -> ReplayOutcome:
        self._require_sample(session_path)
        self._require_sample(noise_path)
        requests = load_session(session_path, self.max_requests)
        ignored = load_noise(noise_path)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()), _NoRedirect())
        outcome = ReplayOutcome(self.backend, len(requests), 0, 0, [])
        for request in requests:
            base = target_for_request(request.index)
            check_local_target(base)
            result = self._send(opener, base.rstrip("/"), request, ignored)
            outcome.results.append(result)
            outcome.executed_count += 1
            outcome.matched_count += int(result.matched)
            if request.index < len(requests):
                try:
                    after_response(request.index)
                except Exception as error:  # KeyboardInterrupt 등은 그대로 올라간다
                    raise ReplayHookError(error, outcome) from error
        return outcome

    def _send(self, opener, base: str, request: RecordedRequest, ignored: list) -> RequestResult:
        headers = dict(request.headers)
        data: Optional[bytes] = None
        if request.body is not None:
            data = json.dumps(request.body).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        http_request = urllib.request.Request(base + request.path, data=data, method=request.method, headers=headers)
        try:
            with opener.open(http_request, timeout=self.request_timeout) as response:
                status, raw = response.status, response.read(self.max_body_bytes + 1)
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read(self.max_body_bytes + 1)
        except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
            reason = getattr(error, "reason", error)
            return RequestResult(request.index, False, "transport", f"전송 실패: {type(reason).__name__}")
        if len(raw) > self.max_body_bytes:
            return RequestResult(request.index, False, "body", "응답 본문이 상한을 넘어 비교하지 못함(잘림)")
        try:
            body = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = raw.decode("utf-8", errors="replace")
        if status != request.expected_status:
            return RequestResult(request.index, False, "status",
                                 f"{request.method} {request.path}: 상태코드 예상 {request.expected_status} → 실제 {status}, "
                                 f"본문 {_preview(body)}")
        if _without_pointers(body, ignored) != _without_pointers(request.expected_body, ignored):
            return RequestResult(request.index, False, "body",
                                 f"{request.method} {request.path}: 본문 예상 {_preview(request.expected_body)} → 실제 {_preview(body)}")
        return RequestResult(request.index, True, None, f"{request.method} {request.path}: 일치")
