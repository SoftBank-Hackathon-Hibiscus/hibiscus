"""실행 ID와 경로 검사. 실행 폴더는 run_root 안에만 만들고 절대 덮어쓰지 않는다."""

import re
import secrets
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .errors import PremortemError

RUN_ID_RE = re.compile(r"^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$")


def validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        raise PremortemError("INVALID_RUN_ID", f"run_id 형식이 아님: {run_id!r}")
    return run_id


def new_run_id(prefix: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return validate_run_id(f"{prefix}-{stamp}-{secrets.token_hex(3)}")


def create_run_dir(run_root: Path, run_id: str) -> Path:
    validate_run_id(run_id)
    root = Path(run_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / run_id
    if target.resolve().parent != root:
        raise PremortemError("INVALID_RUN_ID", "실행 폴더가 run_root 밖을 가리킴")
    try:
        target.mkdir(exist_ok=False)
    except FileExistsError:
        raise PremortemError("RUN_EXISTS", f"같은 run_id의 결과가 이미 있어 덮어쓰지 않음: {run_id}") from None
    return target


def safe_relative(path: str) -> PurePosixPath:
    """상대 경로 문자열만 허용한다. 절대 경로, ..·., 역슬래시, 드라이브, 빈 값은 거부한다."""
    if not isinstance(path, str) or not path or "\x00" in path:
        raise PremortemError("PATH_DENIED", "빈 경로 또는 잘못된 문자")
    if "\\" in path or ":" in path or path.startswith("/"):
        raise PremortemError("PATH_DENIED", f"허용하지 않는 경로 형식: {path}")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise PremortemError("PATH_DENIED", f"경로 이탈 또는 빈 경로 조각: {path}")
    return PurePosixPath(path)


def resolve_inside(root: Path, relative: str) -> Path:
    """root 안의 실제 경로를 돌려준다. 경로 중간이나 끝에 symlink가 있으면 거부한다."""
    parsed = safe_relative(relative)
    root = Path(root).resolve()
    cursor = root
    for part in parsed.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise PremortemError("PATH_DENIED", f"symlink 경로는 허용하지 않음: {relative}")
    resolved = cursor.resolve()
    if not resolved.is_relative_to(root):
        raise PremortemError("PATH_DENIED", f"root 밖을 가리킴: {relative}")
    return resolved
