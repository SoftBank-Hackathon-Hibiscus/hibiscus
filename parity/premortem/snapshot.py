"""검사할 소스의 불변 복사본과 식별값.

일반 파일만 담고 symlink·.git·자격증명·의존성 폴더는 뺀다(뺀 목록을 기록한다). 소스 hash는 정렬된
상대 경로와 파일 bytes의 sha256을 canonical JSON으로 묶어 계산하며 시각을 넣지 않는다.
복사하는 동안 원본이 바뀌면 다시 시도하지 않고 SOURCE_CHANGED로 멈춘다.
"""

import fnmatch
import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .errors import PremortemError
from .process import CommandRunner

EXCLUDED_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".premortem", ".mypy_cache", ".pytest_cache"}
EXCLUDED_FILES = (".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "*.pyc", ".DS_Store")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_listing(source: Path) -> tuple:
    """(파일 목록 [(상대경로, sha256)], 제외 목록)을 돌려준다."""
    source = Path(source)
    files, excludes = [], []
    for current, dirs, names in os.walk(source, followlinks=False):
        current_path = Path(current)
        kept = []
        for name in sorted(dirs):
            rel = (current_path / name).relative_to(source).as_posix()
            if (current_path / name).is_symlink():
                excludes.append(f"{rel} (symlink)")
            elif name in EXCLUDED_DIRS:
                excludes.append(f"{rel}/")
            else:
                kept.append(name)
        dirs[:] = kept
        for name in sorted(names):
            path = current_path / name
            rel = path.relative_to(source).as_posix()
            if path.is_symlink():
                excludes.append(f"{rel} (symlink)")
            elif any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES):
                excludes.append(rel)
            elif path.is_file():
                files.append((rel, sha256_file(path)))
            else:
                excludes.append(f"{rel} (일반 파일 아님)")
    return sorted(files), sorted(excludes)


def tree_hash(files: list) -> str:
    canonical = json.dumps([[path, digest] for path, digest in files], separators=(",", ":"), ensure_ascii=False)
    return sha256_bytes(canonical.encode("utf-8"))


@dataclass(frozen=True)
class Snapshot:
    root: Path
    tree_sha256: str
    files: tuple
    excludes: tuple


def take_snapshot(source: Path, destination: Path) -> Snapshot:
    source, destination = Path(source), Path(destination)
    before, excludes = tree_listing(source)
    if not before:
        raise PremortemError("INPUT_INVALID", f"스냅샷할 일반 파일이 없음: {source}")
    for rel, _ in before:
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / rel, target)
    after, _ = tree_listing(source)
    copied, _ = tree_listing(destination)
    if before != after or before != copied:
        raise PremortemError("SOURCE_CHANGED", "스냅샷을 만드는 동안 소스가 바뀜. 같은 기준으로 검사할 수 없어 중단")
    return Snapshot(destination, tree_hash(before), tuple(before), tuple(excludes))


def git_commit_for(path: Path, runner: CommandRunner) -> str:
    """검사 경로가 git에 추적되고 깨끗할 때만 HEAD를, 그 밖에는 unknown을 돌려준다."""
    try:
        status = runner.run(["git", "-C", str(path), "status", "--porcelain", "--", "."], 15)
        if status.returncode != 0 or status.stdout.strip():
            return "unknown"
        tracked = runner.run(["git", "-C", str(path), "ls-files", "--", "."], 15)
        head = runner.run(["git", "-C", str(path), "rev-parse", "HEAD"], 15)
    except PremortemError:
        return "unknown"
    if tracked.returncode != 0 or not tracked.stdout.strip() or head.returncode != 0:
        return "unknown"
    return head.stdout.strip()


def verify_unchanged(path: Path, expected_sha256: str, code: str = "BASELINE_CHANGED") -> None:
    if sha256_file(path) != expected_sha256:
        raise PremortemError(code, f"기준 파일이 실행 중에 바뀜: {Path(path).name}")


def copy_file(source: Path, destination: Path, expected_sha256: Optional[str] = None) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    digest = sha256_file(destination)
    if expected_sha256 is not None and digest != expected_sha256:
        raise PremortemError("BASELINE_CHANGED", f"복사한 기준 파일의 hash가 다름: {source.name}")
    return digest
