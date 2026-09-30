"""JSON 읽기·쓰기. 중복 키와 NaN·Infinity를 거부하고, 파일은 원자적으로 바꾼다."""

import json
import os
import secrets
from pathlib import Path
from typing import Any

from .errors import PremortemError


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PremortemError("SCHEMA_INVALID", f"JSON 키가 중복됨: {key}")
        result[key] = value
    return result


def _reject_constant(value):
    raise PremortemError("SCHEMA_INVALID", f"JSON에 허용하지 않는 숫자: {value}")


def loads_strict(text: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_no_duplicate_keys, parse_constant=_reject_constant)
    except json.JSONDecodeError as error:
        raise PremortemError("SCHEMA_INVALID", f"JSON 해석 실패: {error.msg} (줄 {error.lineno})") from None


def load_json(path: Path) -> Any:
    return loads_strict(Path(path).read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list:
    rows = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rows.append(loads_strict(line))
        except PremortemError as error:
            raise PremortemError(error.code, f"{Path(path).name} {number}번째 줄: {error.message}") from None
    return rows


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def write_text_atomic(path: Path, text: str) -> None:
    """같은 디렉터리의 임시 파일에 쓰고 flush 후 교체한다. 실패하면 깨진 파일을 남기지 않는다."""
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def write_json_atomic(path: Path, obj: Any) -> None:
    write_text_atomic(path, dumps(obj))


def append_jsonl(path: Path, obj: Any) -> None:
    line = json.dumps(obj, ensure_ascii=False, allow_nan=False) + "\n"
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
