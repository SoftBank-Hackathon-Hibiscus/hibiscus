"""2단계: 재생기.

기록된 요청을 기록 순서대로 대상 서버에 다시 보내고 응답을 모은다.
재생 중간에 끼어들 수 있는 훅(ReplayHook)을 받는다 — 3단계 조건(conditions.py)이
이 훅을 구현해서 "요청 N 뒤에 재시작" 같은 일을 한다.

비밀값 처리 (기록 파일에는 가린 값만 있다):
  - Cookie : 기록의 값은 버리고, 재생 중 서버가 새로 준 Set-Cookie 를 자체 쿠키 저장소에 담아
             다음 요청에 붙인다. 브라우저가 하는 일과 같다.
  - 가려진 다른 헤더(Authorization 등) : 보내지 않는다. 필요하면 extra_headers 로 넣는다 (CLI --header).
  - 가려진 값이 든 본문/쿼리 : 그대로(<redacted>) 보내고 경고한다 — 원래와 다른 요청이 된다.
"""
import http.client
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie

from .record import decode_body, send_request
from .redact import REDACTED


class HookAbort(Exception):
    """훅이 재생을 더 진행할 수 없다고 판단할 때 던진다 (예: 재시작 후 서버가 안 살아남)."""


class ReplayHook:
    """재생 중 끼어드는 지점. 필요한 메서드만 오버라이드하면 된다.
    index 는 기록 파일의 요청 번호(1부터)."""

    def before_run(self, indices):
        pass

    def before_request(self, index):
        pass

    def after_request(self, index):
        pass


@dataclass
class Response:
    status: int                  # 0 = 연결 자체가 실패
    headers: list
    body: bytes
    error: str = None


@dataclass
class ReplayResult:
    responses: list              # records 와 같은 순서. 실행 못 한 요청은 None
    error: str = None            # 훅이 재생을 중단시켰다면 그 이유


def update_jar(jar, headers):
    for name, value in headers:
        if name.lower() != "set-cookie":
            continue
        cookie = SimpleCookie()
        try:
            cookie.load(value)
        except CookieError:
            continue
        for key, morsel in cookie.items():
            if morsel.value == "" or morsel["max-age"] == "0":
                jar.pop(key, None)
            else:
                jar[key] = morsel.value


def build_headers(recorded, jar, extra_headers):
    """재생할 요청 헤더와, 가려져 있어 뺀 헤더 이름 목록을 돌려준다."""
    extra_names = {k.lower() for k, _ in extra_headers}
    headers, dropped = [], []
    for name, value in recorded:
        low = name.lower()
        if low == "cookie" or low in extra_names:
            continue
        if REDACTED in value:
            dropped.append(name)
            continue
        headers.append([name, value])
    headers += [[k, v] for k, v in extra_headers]
    if jar:
        headers.append(["Cookie", "; ".join(f"{k}={v}" for k, v in jar.items())])
    return headers, dropped


def _send(record, target, jar, timeout, extra_headers, ssl_context, warn):
    req = record["request"]
    headers, dropped = build_headers(req["headers"], jar, extra_headers)
    for name in dropped:
        warn(f"header:{name.lower()}",
             f"[replay] 경고: 기록에서 가려진 {name} 헤더는 보내지 않습니다 (필요하면 --header '{name}: ...')")
    body = decode_body(req)
    if REDACTED in req["path"] or REDACTED.encode() in body:
        warn(f"body:{record['index']}",
             f"[replay] 경고: #{record['index']} 의 쿼리/본문에 가려진 값이 있어 원래와 다른 요청이 전송됩니다")
    try:
        status, _, resp_headers, resp_body = send_request(
            target, req["method"], req["path"], headers, body, timeout, ssl_context)
    except (OSError, http.client.HTTPException) as e:
        return Response(0, [], b"", error=f"{type(e).__name__}: {e}")
    update_jar(jar, resp_headers)
    return Response(status, resp_headers, resp_body)


def replay(records, target, hooks=(), timeout=30, extra_headers=(), ssl_context=None, log=None):
    """records 를 순서대로 target 에 재생한다. 훅이 HookAbort 를 던지면 거기서 멈춘다."""
    warned = set()

    def warn(key, message):
        if log and key not in warned:
            warned.add(key)
            log(message)

    jar = {}
    responses = [None] * len(records)
    try:
        for hook in hooks:
            hook.before_run([r["index"] for r in records])
        for pos, rec in enumerate(records):
            for hook in hooks:
                hook.before_request(rec["index"])
            responses[pos] = _send(rec, target, jar, timeout, list(extra_headers), ssl_context, warn)
            for hook in hooks:
                hook.after_request(rec["index"])
    except HookAbort as e:
        return ReplayResult(responses, error=str(e))
    return ReplayResult(responses)
