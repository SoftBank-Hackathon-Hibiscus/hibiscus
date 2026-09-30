"""검사를 통과한 edit를 소스 복사본에만 적용하고, 실제 diff를 프로그램이 만든다.

원본(검사한 스냅샷과 사용자 앱 폴더)은 바꾸지 않으며, 적용 전후 hash로 확인한다.
"""

import difflib
from dataclasses import dataclass
from pathlib import Path

from ..errors import PremortemError
from ..jsonio import write_text_atomic
from ..snapshot import sha256_bytes, take_snapshot, tree_hash, tree_listing


@dataclass(frozen=True)
class PatchResult:
    patched_root: Path
    diff_text: str
    diff_sha256: str
    source_tree_sha256: str
    patched_tree_sha256: str
    changed_files: tuple


def apply_to_copy(source_root: Path, planned: list, destination: Path) -> PatchResult:
    before_files, _ = tree_listing(source_root)
    source_tree = tree_hash(before_files)
    copy = take_snapshot(source_root, destination)
    by_file: dict = {}
    for edit in planned:
        by_file.setdefault(edit.path, []).append(edit)
    diffs = []
    for path, edits in sorted(by_file.items()):
        target = destination / path
        original = target.read_text(encoding="utf-8")
        text = original
        for edit in sorted(edits, key=lambda e: e.offset, reverse=True):  # 뒤에서부터 바꿔야 앞 offset이 유지된다
            text = text[: edit.offset] + edit.after + text[edit.offset + len(edit.before):]
        write_text_atomic(target, text)
        diffs.extend(difflib.unified_diff(original.splitlines(keepends=True), text.splitlines(keepends=True),
                                          fromfile=f"a/{path}", tofile=f"b/{path}"))
    after_files, _ = tree_listing(source_root)
    if tree_hash(after_files) != source_tree:
        raise PremortemError("SOURCE_CHANGED", "수정 적용 중에 원본 소스가 바뀜")
    diff_text = "".join(diffs)
    patched_files, _ = tree_listing(destination)
    return PatchResult(destination, diff_text, sha256_bytes(diff_text.encode("utf-8")), copy.tree_sha256,
                       tree_hash(patched_files), tuple(sorted(by_file)))
