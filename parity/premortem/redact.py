"""저장하거나 AI에 보내기 전에 비밀값으로 보이는 문자열을 가린다.

이름 규칙으로 찾지 못하는 비밀값이나 HTML·바이너리 안의 값까지 완벽히 가린다고 주장하지 않는다.
"""

import re

_PATTERNS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]"),
    (re.compile(r"(?i)\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;\"']+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 [REDACTED]"),
    (re.compile(r"(?i)\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|session[_-]?id|cookie)"
                r"[\"']?\s*[:=]\s*[\"']?)[^\s\"',;&}]+"), r"\1[REDACTED]"),
    (re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}"), "[REDACTED]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED]"),
]


def redact(text: str) -> str:
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text
