"""응답 비교.

응답을 View(status, body)로 만든 뒤 "경로 → 값" 평면 사전으로 펼쳐서 비교한다.
  {"status": 200, "body": [{"id": 1, "created_at": "..."}]}
  → {"status": 200, "body[0].id": 1, "body[0].created_at": "..."}
값이 다른 경로가 곧 차이점(FieldDiff)이다. 헤더는 비교하지 않는다 (Date, Set-Cookie 등은 매번 바뀜).

노이즈 규칙("body[*].created_at" 처럼 목록 번호를 [*] 로 일반화한 경로)이 있어도
아래 차이는 **절대 무시하지 않는다** (can_ignore):
  - 상태코드(status) 차이
  - 어느 한쪽이 연결 실패이거나 재생되지 않음
  - 필드가 한쪽에만 있음 (missing)
  - 값의 타입이 바뀜 (예: 문자열 → null)
노이즈 규칙이 용서하는 것은 "양쪽 모두 있고 타입이 같은데 값만 다른" 경우뿐이다.

기록에서 비밀값이 가려진 필드(<redacted>)는 값을 알 수 없으므로 "실제 응답에도 그 필드가 있는지"만 본다.
"""
import hashlib
import json
import re
from dataclasses import dataclass

from .record import decode_body, header_value
from .redact import REDACTED, redact_json

_INDEX_RE = re.compile(r"\[\d+\]")


class _Missing:
    def __repr__(self):
        return "<missing>"


MISSING = _Missing()


@dataclass
class View:
    status: object            # 정수. 연결 실패면 0, 재생하지 못했으면 None
    body: object              # JSON 이면 파싱한 값, 글자면 문자열, 바이너리면 요약 문자열
    failure: str = None       # 연결 실패/미실행이면 그 이유

    def flat(self):
        return flatten({"status": self.status, "body": self.body})


def make_view(status, headers, body):
    ctype = (header_value(headers, "content-type") or "").lower()
    if "json" in ctype:
        try:
            return View(status, json.loads(body))
        except ValueError:
            pass
    try:
        value = body.decode("utf-8")
    except UnicodeDecodeError:
        value = f"<binary {len(body)} bytes sha256={hashlib.sha256(body).hexdigest()[:16]}>"
    return View(status, value)


def view_recorded(response_part):
    return make_view(response_part["status"], response_part["headers"], decode_body(response_part))


def view_replayed(response):
    if response is None:
        return View(None, "<not replayed>", failure="not replayed")
    if response.error:
        return View(0, f"<connection error: {response.error}>", failure=f"connection error: {response.error}")
    return make_view(response.status, response.headers, response.body)


def flatten(value, prefix="", out=None):
    out = {} if out is None else out
    if isinstance(value, dict) and value:
        for k, v in value.items():
            flatten(v, f"{prefix}.{k}" if prefix else k, out)
    elif isinstance(value, list) and value:
        for i, v in enumerate(value):
            flatten(v, f"{prefix}[{i}]", out)
    else:
        out[prefix] = value      # 원시값, 또는 빈 [] / {}
    return out


def type_class(value):
    if value is MISSING:
        return "missing"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if value is None:
        return "null"
    return {str: "string", list: "array", dict: "object"}.get(type(value), "other")


def same_value(a, b):
    # JSON 에서 true 와 1 은 다른 값인데 파이썬에선 True == 1 이므로 타입까지 본다.
    return type(a) is type(b) and a == b


def generalize(path):
    return _INDEX_RE.sub("[*]", path)


@dataclass
class FieldDiff:
    path: str
    expected: object
    actual: object

    @property
    def kind(self):
        if self.expected is MISSING or self.actual is MISSING:
            return "missing"
        if type_class(self.expected) != type_class(self.actual):
            return "type_changed"
        return "value_changed"


def field_diffs(expected, actual):
    """두 View 사이에 값이 다른 경로 목록 (한쪽에만 있는 경로 포함)."""
    fe, fa = expected.flat(), actual.flat()
    diffs = []
    for path in sorted(fe.keys() | fa.keys()):
        e, a = fe.get(path, MISSING), fa.get(path, MISSING)
        if same_value(e, a):
            continue
        if e == REDACTED and a is not MISSING and not isinstance(a, (list, dict)):
            continue  # 기록에서 가린 비밀값: 실제 응답에 값이 있으면 통과
        diffs.append(FieldDiff(path, e, a))
    return diffs


def diff_paths(expected, actual):
    return [d.path for d in field_diffs(expected, actual)]


def can_ignore(diff, expected, actual, rules):
    """노이즈 규칙으로 이 차이를 무시해도 되는가. 규칙에 있어도 안전하지 않으면 False."""
    return (not expected.failure and not actual.failure
            and diff.path != "status"
            and diff.kind == "value_changed"
            and generalize(diff.path) in rules)


def significant_diffs(expected, actual, rules=()):
    """노이즈 규칙으로 무시할 수 있는 것을 뺀 나머지 차이."""
    rules = set(rules)
    return [d for d in field_diffs(expected, actual) if not can_ignore(d, expected, actual, rules)]


def render(view, limit=200):
    """사람이 읽는 한 줄 요약: '200 {"name":"alice"}'. 결과 파일에 비밀값이 새지 않게 가린다."""
    body = view.body
    text = body if isinstance(body, str) else json.dumps(redact_json(body), ensure_ascii=False,
                                                         separators=(",", ":"))
    line = f"{view.status} {text}"
    return line if len(line) <= limit else line[: limit - 1] + "…"
