"""기록 파일에 남기기 전에 비밀값을 가린다.

프록시는 원본을 그대로 전달하고(전달용), 파일에는 가린 사본만 쓴다(저장용).
  헤더  Authorization, Proxy-Authorization, X-Api-Key, X-Auth-Token, X-CSRF-Token … → <redacted>
        Cookie: sid=abc; theme=dark            → sid=<redacted>; theme=<redacted>   (이름은 남김)
        Set-Cookie: sid=abc; Path=/; HttpOnly  → sid=<redacted>; Path=/; HttpOnly
  본문  JSON · form-urlencoded 의 password, token, secret, api_key … 필드 값
  쿼리  ?access_token=…&page=2               → ?access_token=<redacted>&page=2

판별은 이름으로 한다(is_sensitive). JSON·form 이 아닌 본문(HTML, 바이너리) 안의 비밀값은 가리지 못한다.
"""
import json
import re
from urllib.parse import unquote_plus

REDACTED = "<redacted>"

# 소문자로 바꾸고 영숫자만 남긴 이름 기준. 짧은 이름은 정확히 일치할 때만 (author 가 auth 로 잡히지 않게).
_EXACT = {"auth", "sid", "pwd", "otp"}
_SUFFIXES = ("password", "passwd", "passphrase", "secret", "token", "apikey", "sessionid",
             "csrf", "xsrf", "authorization", "credential", "credentials", "privatekey", "signature")


def is_sensitive(name):
    n = re.sub(r"[^a-z0-9]", "", name.lower())
    return n in _EXACT or n.endswith(_SUFFIXES)


def _mask_query_like(text):
    """'page=2&token=x' 에서 민감한 이름의 값만 가린다. 나머지는 원문 그대로 둔다."""
    parts = text.split("&")
    for i, part in enumerate(parts):
        key, eq, value = part.partition("=")
        if eq and value and is_sensitive(unquote_plus(key)):
            parts[i] = f"{key}={REDACTED}"
    return "&".join(parts)


def mask_cookie_header(value):
    """Cookie 헤더: 쿠키 이름은 남기고 값은 모두 가린다."""
    out = []
    for part in value.split(";"):
        key, eq, val = part.strip().partition("=")
        out.append(f"{key}={REDACTED}" if eq and val else part.strip())
    return "; ".join(out)


def mask_set_cookie(value):
    """Set-Cookie 헤더: 값만 가리고 Path, Max-Age 등 속성은 남긴다. 빈 값(삭제 쿠키)은 그대로."""
    first, sep, rest = value.partition(";")
    key, eq, val = first.strip().partition("=")
    if eq and val.strip():
        first = f"{key}={REDACTED}"
    return first + sep + rest


def redact_headers(headers):
    out = []
    for name, value in headers:
        low = name.lower()
        if low == "cookie":
            value = mask_cookie_header(value)
        elif low == "set-cookie":
            value = mask_set_cookie(value)
        elif is_sensitive(name):
            value = REDACTED
        out.append([name, value])
    return out


def redact_json(value, masked=False):
    """민감한 이름의 필드 값을 가린 사본. 필드 안이 객체/배열이면 구조는 두고 안의 값만 가린다
    (구조가 남아야 비교할 때 '필드가 있는지'는 계속 확인할 수 있다)."""
    if isinstance(value, dict):
        return {k: redact_json(v, masked or is_sensitive(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_json(v, masked) for v in value]
    if masked and value is not None and value != "":
        return REDACTED
    return value


def redact_body(data, content_type):
    """본문 bytes 에서 비밀값을 가린다. 가릴 것이 없으면 원래 bytes 를 그대로 돌려준다."""
    ctype = (content_type or "").lower()
    if "json" in ctype:
        try:
            parsed = json.loads(data)
        except ValueError:
            return data
        masked = redact_json(parsed)
        return data if masked == parsed else json.dumps(masked, ensure_ascii=False).encode("utf-8")
    if "application/x-www-form-urlencoded" in ctype:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return data
        masked = _mask_query_like(text)
        return data if masked == text else masked.encode("utf-8")
    return data


def redact_path(path):
    base, q, query = path.partition("?")
    return base + q + _mask_query_like(query) if q else path
