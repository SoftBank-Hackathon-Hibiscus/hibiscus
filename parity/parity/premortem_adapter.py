"""선택적 premortem ReplayPort 연결. Docker·빌드·AI·정책 실행은 하지 않는다.

PR #4의 ReplayPort 계약(7bd00d84)에 맞춘다. premortem은 replay를 호출할 때만
import하므로, 이 모듈을 추가해도 기존 parity 설치에 새 필수 의존성이 생기지 않는다.
기준은 parity의 JSONL과 noise rules만 받으며 reference 샘플 형식을 추측하지 않는다.
"""
import base64
import binascii
import json
import math
import re
from collections.abc import Mapping
from pathlib import Path

from .compare import significant_diffs, view_recorded, view_replayed
from .replay import replay as replay_records


_METHOD = re.compile(r"^[A-Z]+$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def _protocol():
    try:
        from premortem.errors import PremortemError
        from premortem.replay_port import ReplayHookError, ReplayOutcome, RequestResult
    except ImportError:
        raise RuntimeError(
            "premortem ReplayPort가 필요합니다. PR #4 모듈을 같은 Python 경로에 준비한 뒤 연결하세요."
        ) from None
    return PremortemError, ReplayHookError, ReplayOutcome, RequestResult


def _headers_valid(headers):
    return isinstance(headers, list) and all(
        isinstance(pair, list) and len(pair) == 2
        and all(isinstance(value, str) for value in pair)
        and pair[0] and all("\r" not in value and "\n" not in value for value in pair)
        for pair in headers
    )


def _part_valid(part):
    if not isinstance(part, dict) or not _headers_valid(part.get("headers")):
        return False
    if not isinstance(part.get("body"), str) or part.get("body_encoding") not in ("utf8", "base64"):
        return False
    if part["body_encoding"] == "base64":
        try:
            base64.b64decode(part["body"], validate=True)
        except (ValueError, binascii.Error):
            return False
    return True


def _load_baseline(session_path, noise_path, max_requests, error_type):
    """파일을 한 번 읽어 고정한다. 오류에 경로·본문·파싱 예외 원문을 싣지 않는다."""
    try:
        session_path, noise_path = Path(session_path), Path(noise_path)
        session_bytes, noise_bytes = session_path.read_bytes(), noise_path.read_bytes()
        records = [json.loads(line) for line in session_bytes.decode("utf-8-sig").splitlines() if line.strip()]
        noise = json.loads(noise_bytes.decode("utf-8-sig"))
    except (OSError, ValueError, TypeError, UnicodeError):
        raise error_type("INPUT_INVALID", "기록 또는 노이즈 파일을 읽을 수 없거나 JSON 형식이 잘못되었습니다") from None
    if not records or len(records) > max_requests:
        raise error_type("INPUT_INVALID", "기록은 비어 있지 않아야 하며 설정한 요청 수 상한 이하여야 합니다")
    for index, record in enumerate(records, 1):
        if not isinstance(record, dict) or type(record.get("index")) is not int or record["index"] != index:
            raise error_type("INPUT_INVALID", "parity 기록의 index는 파일 순서대로 1부터 연속된 정수여야 합니다")
        request, response = record.get("request"), record.get("response")
        if not _part_valid(request) or not _part_valid(response):
            raise error_type("INPUT_INVALID", f"요청 #{index}: parity request/response 형식이 아닙니다")
        method, path, status = request.get("method"), request.get("path"), response.get("status")
        if (not isinstance(method, str) or not _METHOD.fullmatch(method)
                or not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
                or "\\" in path or any(ord(char) < 32 or ord(char) == 127 for char in path)
                or type(status) is not int or not 100 <= status <= 599):
            raise error_type("INPUT_INVALID", f"요청 #{index}: 메서드·상대 경로·기대 상태코드 형식이 잘못되었습니다")
    if (not isinstance(noise, dict) or not isinstance(noise.get("rules"), list)
            or "ignored_json_pointers" in noise
            or ("candidates" in noise and not isinstance(noise["candidates"], list))):
        raise error_type("INPUT_INVALID", "parity noise의 rules 목록이 필요합니다. reference 노이즈 형식은 지원하지 않습니다")
    rules = {}
    for rule in noise["rules"]:
        if not isinstance(rule, dict):
            raise error_type("INPUT_INVALID", "노이즈 규칙은 객체여야 합니다")
        index, fields = rule.get("index"), rule.get("fields")
        if (type(index) is not int or not 1 <= index <= len(records) or index in rules
                or not isinstance(fields, list) or not all(isinstance(field, str) and field for field in fields)):
            raise error_type("INPUT_INVALID", "노이즈 규칙의 요청 번호 또는 fields가 잘못되었습니다")
        if "body" in fields:
            raise error_type("INPUT_INVALID", "응답 본문 전체(body)를 제외하는 노이즈 규칙은 지원하지 않습니다")
        rules[index] = set(fields)
    return records, rules, ((session_path, session_bytes), (noise_path, noise_bytes))


class ParityReplayPort:
    """premortem의 replay_port 인자에 직접 넘길 수 있는 재생 어댑터.

    생성자는 외부 모듈을 import하지 않는다. facts는 Docker를 관찰하지 않았으므로 None이다.
    runtime_secrets는 아직 팀 계약이 없어 빈 매핑만 허용한다. 콜백은 신뢰하는 환경 실행기가
    제공하며 동일 앱의 현재 주소를 반환해야 한다. 본문·URL·예외 원문은 결과 요약에 넣지 않는다.
    """

    backend = "parity"

    def __init__(self, request_timeout=5.0, max_requests=200, ssl_context=None):
        if (isinstance(request_timeout, bool) or not isinstance(request_timeout, (int, float))
                or not math.isfinite(request_timeout) or request_timeout <= 0):
            raise ValueError("request_timeout은 양의 유한한 숫자여야 합니다")
        if type(max_requests) is not int or max_requests < 1:
            raise ValueError("max_requests는 양의 정수여야 합니다")
        self.request_timeout = request_timeout
        self.max_requests = max_requests
        self.ssl_context = ssl_context

    def replay(self, session_path, noise_path, target_for_request, after_response, runtime_secrets):
        Error, HookError, Outcome, RequestResult = _protocol()
        if not isinstance(runtime_secrets, Mapping):
            raise Error("INPUT_INVALID", "runtime_secrets는 빈 매핑이어야 합니다")
        if runtime_secrets:
            raise Error("MISSING_REPLAY_SECRET", "runtime_secrets 주입 방식은 아직 지원하지 않습니다. 공통 매핑 계약이 필요합니다")
        if not callable(target_for_request) or not callable(after_response):
            raise Error("INPUT_INVALID", "대상 주소와 요청 사이 조건을 제공하는 콜백이 필요합니다")
        records, noise, baseline = _load_baseline(session_path, noise_path, self.max_requests, Error)
        outcome = Outcome(self.backend, len(records), 0, 0, facts=None)

        def observe(index, record, response):
            expected, actual = view_recorded(record["response"]), view_replayed(response)
            diffs = significant_diffs(expected, actual, noise.get(index, ()))
            if response.error:
                kind, summary = "transport", f"요청 #{index}: 응답을 받지 못했습니다"
            elif expected.status != actual.status:
                kind = "status"
                summary = f"요청 #{index}: 상태코드 예상 {expected.status}, 실제 {actual.status}"
            elif diffs:
                kind, summary = "body", f"요청 #{index}: 응답 본문 불일치 ({len(diffs)}개 필드)"
            else:
                kind, summary = None, f"요청 #{index}: 일치"
            matched = kind is None
            outcome.results.append(RequestResult(index, matched, kind, summary))
            outcome.executed_count += 1
            outcome.matched_count += int(matched)
            if response.error:
                raise Error("REPLAY_TRANSPORT_FAILED", "응답을 받지 못해 재생을 중단했습니다")

        # 주소는 반드시 외부 소유자가 요청 직전에 결정한다. 이 어댑터는 컨테이너를 조작하지 않는다.
        result = replay_records(
            records, None, timeout=self.request_timeout, ssl_context=self.ssl_context,
            target_for_request=target_for_request, on_response=observe, after_response=after_response,
        )
        try:
            unchanged = all(path.read_bytes() == original for path, original in baseline)
        except OSError:
            unchanged = False
        if not unchanged:
            raise HookError(Error("BASELINE_CHANGED", "재생 중 기록 또는 노이즈 기준 파일이 변경되었습니다"), outcome) from None
        if result.error:
            cause = result.cause
            code = getattr(cause, "code", None) if isinstance(cause, Error) else None
            if not isinstance(code, str) or not _ERROR_CODE.fullmatch(code):
                code = "REPLAY_FAILED"
            # 외부 예외 메시지는 주소·인증값을 포함할 수 있으므로 내보내지 않는다.
            safe_cause = Error(code, "재생 또는 외부 환경 콜백이 중단되었습니다. 부분 실행 결과를 확인하세요")
            raise HookError(safe_cause, outcome) from None
        if len(outcome.results) != len(records):
            raise HookError(Error("REPLAY_INCOMPLETE", "모든 요청의 비교 결과를 수집하지 못했습니다"), outcome) from None
        return outcome
