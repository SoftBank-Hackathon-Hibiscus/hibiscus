"""내부 계약 스키마 검사. jsonschema가 없으면 '미검사'로 알리고 검사 완료라고 하지 않는다."""

import functools
from pathlib import Path
from typing import Any

from .errors import PremortemError
from .jsonio import load_json

SCHEMA_DIR = Path(__file__).parent / "schemas"
KINDS = ("env-report", "run-manifest", "evidence-event", "handoff-bundle", "analysis-output", "analysis-record")


def jsonschema_available() -> bool:
    try:
        import jsonschema  # noqa: F401
    except ImportError:
        return False
    return True


@functools.lru_cache(maxsize=None)
def _validator(kind: str):
    from jsonschema import Draft202012Validator, FormatChecker

    if kind not in KINDS:
        raise PremortemError("SCHEMA_INVALID", f"모르는 스키마 종류: {kind}")
    schema = load_json(SCHEMA_DIR / f"{kind}.schema.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def schema(kind: str) -> dict:
    return load_json(SCHEMA_DIR / f"{kind}.schema.json")


def validate(kind: str, obj: Any) -> str:
    """검사했으면 'checked', jsonschema가 없어 못 했으면 'unchecked'를 돌려준다."""
    if not jsonschema_available():
        return "unchecked"
    errors = sorted(_validator(kind).iter_errors(obj), key=lambda e: [str(p) for p in e.path])
    if errors:
        first = errors[0]
        where = "/".join(str(p) for p in first.path) or "(최상위)"
        raise PremortemError("SCHEMA_INVALID", f"{kind} {where}: {first.message}")
    return "checked"
