"""AI 수정안 검사 (IMPLEMENTATION_SPEC 14절).

before/after 문자열 치환만 받는다. 모든 edit를 먼저 검사하고, 하나라도 걸리면 전부 거부한다.
- 허용한 앱 소스(.py/.js/.ts/.jsx/.tsx)만. 경로가 허용 목록 안이어도 금지 범주면 거부한다.
- 절대 경로, .., 드라이브, UNC, 역슬래시, symlink, 없는 파일(새 파일), binary는 거부한다.
- before는 그 파일에 정확히 한 번 나와야 한다. 같은 파일 안 edit가 겹치면 거부한다.
- 파일 수·바뀌는 줄 수·바이트 수에 상한이 있다.
"""

import fnmatch
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from ..config import Settings
from ..errors import PremortemError
from ..paths import resolve_inside, safe_relative

ALLOWED_SUFFIXES = {".py", ".js", ".ts", ".jsx", ".tsx"}
DENIED_DIRS = {
    ".github", ".gitlab", ".circleci", "policy", "policies", "infra", "terraform", "deploy", "k8s", "helm",
    "tests", "test", "__tests__", "fixtures", "baseline", "recordings", "premortem", "parity",
    ".premortem", "signing", "keys", "secrets", "auth", "contracts",
}
DENIED_FILE_PATTERNS = (
    "dockerfile*", "*.dockerfile", "docker-compose*", "compose.y*ml", "*.lock", "package-lock.json",
    "pnpm-lock.yaml", "requirements*.txt", "pyproject.toml", ".env*", "*.pem", "*.key",
    "test_*", "*_test.*", "*.test.*", "*.spec.*", "*session*.jsonl", "*noise*.json", "policy*.y*ml",
    "conftest.py", "setup.py", "*.cfg", "*.ini",
)


@dataclass(frozen=True)
class PlannedEdit:
    path: str
    offset: int
    before: str
    after: str


def _deny(message: str) -> None:
    raise PremortemError("PATCH_PATH_DENIED", message)


def check_path(path: str, allowed_paths: tuple) -> PurePosixPath:
    try:
        parsed = safe_relative(path)
    except PremortemError as error:
        _deny(error.message)
    lowered_parts = [part.lower() for part in parsed.parts]
    if any(part in DENIED_DIRS for part in lowered_parts[:-1]):
        _deny(f"고칠 수 없는 범주의 폴더: {path}")
    if any(fnmatch.fnmatch(lowered_parts[-1], pattern) for pattern in DENIED_FILE_PATTERNS):
        _deny(f"고칠 수 없는 범주의 파일(설정·테스트·기록·잠금·인프라): {path}")
    if parsed.suffix.lower() not in ALLOWED_SUFFIXES:
        _deny(f"앱 소스 파일만 고칠 수 있음: {path}")
    if path not in allowed_paths:
        _deny(f"이번 실행에서 허용한 앱 소스가 아님: {path}")
    return parsed


def check_edits(edits: list, source_root: Path, allowed_paths: tuple, settings: Settings) -> list:
    """모든 edit를 검사해서 적용할 목록을 돌려준다. 하나라도 문제가 있으면 예외로 전체를 거부한다."""
    planned, spans, texts = [], {}, {}
    changed_lines = changed_bytes = 0
    for edit in edits:
        path, before, after = edit.get("path"), edit.get("before"), edit.get("after")
        if not isinstance(path, str) or not isinstance(before, str) or not isinstance(after, str) or not before:
            raise PremortemError("PATCH_AMBIGUOUS", "edit에는 path, 비어 있지 않은 before, after가 있어야 함")
        check_path(path, allowed_paths)
        try:
            target = resolve_inside(source_root, path)
        except PremortemError as error:
            _deny(error.message)
        if not target.is_file():
            _deny(f"없는 파일은 만들 수 없음(새 파일·삭제·이름 변경은 자동 적용하지 않음): {path}")
        if path not in texts:
            raw = target.read_bytes()
            if b"\x00" in raw:
                _deny(f"binary 파일은 고칠 수 없음: {path}")
            try:
                texts[path] = raw.decode("utf-8")
            except UnicodeDecodeError:
                _deny(f"UTF-8 텍스트가 아닌 파일은 고칠 수 없음: {path}")
        if "\x00" in after:
            _deny("after에 NUL 문자가 있음")
        count = texts[path].count(before)
        if count != 1:
            raise PremortemError("PATCH_AMBIGUOUS", f"before가 {path}에 {count}번 나옴. 정확히 한 번이어야 함")
        offset = texts[path].index(before)
        for start, end in spans.get(path, []):
            if offset < end and start < offset + len(before):
                raise PremortemError("PATCH_AMBIGUOUS", f"같은 파일의 edit가 겹침: {path}")
        spans.setdefault(path, []).append((offset, offset + len(before)))
        changed_lines += len(before.splitlines() or [""]) + len(after.splitlines() or [""])
        changed_bytes += len(before.encode("utf-8")) + len(after.encode("utf-8"))
        planned.append(PlannedEdit(path, offset, before, after))
    if len(texts) > settings.max_patch_files:
        raise PremortemError("PATCH_TOO_LARGE", f"수정 파일 {len(texts)}개가 상한 {settings.max_patch_files}개를 넘음")
    if changed_lines > settings.max_patch_changed_lines:
        raise PremortemError("PATCH_TOO_LARGE", f"바뀌는 줄 {changed_lines}줄이 상한 {settings.max_patch_changed_lines}줄을 넘음")
    if changed_bytes > settings.max_patch_bytes:
        raise PremortemError("PATCH_TOO_LARGE", f"바뀌는 내용 {changed_bytes}바이트가 상한 {settings.max_patch_bytes}바이트를 넘음")
    return planned
