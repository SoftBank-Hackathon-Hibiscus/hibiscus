"""소스 스냅샷과 기준 기록 고정 (ACCEPTANCE A05, A06, A07)."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from premortem import snapshot
from premortem.errors import PremortemError
from premortem.process import SubprocessRunner


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.src = Path(self.tmp.name) / "src"
        (self.src / "pkg").mkdir(parents=True)
        (self.src / "app.py").write_text("HOST = '127.0.0.1'\n", encoding="utf-8")
        (self.src / "pkg" / "util.py").write_text("x = 1\n", encoding="utf-8")

    def test_hash_is_stable_and_content_based(self):
        first = snapshot.take_snapshot(self.src, Path(self.tmp.name) / "a")
        second = snapshot.take_snapshot(self.src, Path(self.tmp.name) / "b")
        self.assertEqual(first.tree_sha256, second.tree_sha256)
        (self.src / "app.py").write_text("HOST = '0.0.0.0'\n", encoding="utf-8")
        third = snapshot.take_snapshot(self.src, Path(self.tmp.name) / "c")
        self.assertNotEqual(first.tree_sha256, third.tree_sha256)

    def test_secrets_and_git_are_excluded(self):
        (self.src / ".env").write_text("TOKEN=abc\n", encoding="utf-8")
        (self.src / ".git").mkdir()
        (self.src / ".git" / "config").write_text("[core]\n", encoding="utf-8")
        snap = snapshot.take_snapshot(self.src, Path(self.tmp.name) / "out")
        self.assertEqual([path for path, _ in snap.files], ["app.py", "pkg/util.py"])
        self.assertIn(".env", snap.excludes)
        self.assertFalse((Path(self.tmp.name) / "out" / ".env").exists())

    @unittest.skipIf(os.name == "nt", "symlink 생성 권한이 필요한 환경")
    def test_a05_symlink_is_not_followed(self):
        outside = Path(self.tmp.name) / "outside.txt"
        outside.write_text("secret\n", encoding="utf-8")
        (self.src / "link.txt").symlink_to(outside)
        snap = snapshot.take_snapshot(self.src, Path(self.tmp.name) / "out")
        self.assertIn("link.txt (symlink)", snap.excludes)
        self.assertFalse((Path(self.tmp.name) / "out" / "link.txt").exists())

    def test_a06_source_changed_during_snapshot(self):
        real = snapshot.tree_listing
        calls = {"n": 0}

        def changing(path):
            files, excludes = real(path)
            calls["n"] += 1
            if calls["n"] == 2:  # 복사 뒤 원본을 다시 읽을 때 바뀐 것처럼
                files = files + [("new.py", "0" * 64)]
            return files, excludes

        with mock.patch.object(snapshot, "tree_listing", side_effect=changing):
            with self.assertRaises(PremortemError) as caught:
                snapshot.take_snapshot(self.src, Path(self.tmp.name) / "out")
        self.assertEqual(caught.exception.code, "SOURCE_CHANGED")

    def test_a07_baseline_bytes_changed(self):
        baseline = self.src / "app.py"
        digest = snapshot.sha256_file(baseline)
        snapshot.verify_unchanged(baseline, digest)
        baseline.write_text("changed\n", encoding="utf-8")
        with self.assertRaises(PremortemError) as caught:
            snapshot.verify_unchanged(baseline, digest)
        self.assertEqual(caught.exception.code, "BASELINE_CHANGED")

    def test_commit_is_unknown_outside_clean_git(self):
        self.assertEqual(snapshot.git_commit_for(self.src, SubprocessRunner()), "unknown")


if __name__ == "__main__":
    unittest.main()
