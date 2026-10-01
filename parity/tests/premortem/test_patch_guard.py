"""패치 가드와 복사본 적용 (ACCEPTANCE D08~D14)."""

import os
import tempfile
import unittest
from pathlib import Path

from premortem.config import Settings
from premortem.errors import PremortemError
from premortem.patch.guard import check_edits
from premortem.patch.workspace import apply_to_copy
from premortem.snapshot import tree_hash, tree_listing

APP = 'import os\nHOST = "127.0.0.1"\nPORT = int(os.environ.get("PORT", "8080"))\n'
FIX = {"path": "app.py", "before": 'HOST = "127.0.0.1"', "after": 'HOST = "0.0.0.0"'}


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "source"
        self.root.mkdir()
        (self.root / "app.py").write_text(APP, encoding="utf-8")
        (self.root / "Dockerfile").write_text("FROM python:3.12-slim\n", encoding="utf-8")
        self.allowed = ("app.py",)
        self.settings = Settings()

    def check(self, edits, allowed=None, settings=None):
        return check_edits(edits, self.root, allowed or self.allowed, settings or self.settings)

    def assert_code(self, code, edits, **kwargs):
        with self.assertRaises(PremortemError) as caught:
            self.check(edits, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_d01_valid_edit(self):
        planned = self.check([FIX])
        self.assertEqual(len(planned), 1)

    def test_d08_before_must_appear_exactly_once(self):
        self.assert_code("PATCH_AMBIGUOUS", [{"path": "app.py", "before": "NOT THERE", "after": "x"}])
        (self.root / "app.py").write_text(APP + 'HOST = "127.0.0.1"\n', encoding="utf-8")
        self.assert_code("PATCH_AMBIGUOUS", [FIX])
        self.assert_code("PATCH_AMBIGUOUS", [{"path": "app.py", "before": "", "after": "x"}])

    def test_d09_path_escapes_rejected(self):
        for bad in ("../app.py", "/etc/passwd", "C:/app.py", "\\\\server\\share\\app.py", "a\\app.py", "./app.py"):
            with self.subTest(bad=bad):
                self.assert_code("PATCH_PATH_DENIED", [dict(FIX, path=bad)], allowed=(bad,))

    @unittest.skipIf(os.name == "nt", "symlink 생성 권한이 필요한 환경")
    def test_d09_symlink_rejected(self):
        outside = Path(self.tmp.name) / "outside.py"
        outside.write_text(APP, encoding="utf-8")
        (self.root / "link.py").symlink_to(outside)
        self.assert_code("PATCH_PATH_DENIED", [dict(FIX, path="link.py")], allowed=("link.py",))

    def test_d10_forbidden_categories_rejected_even_if_allowed(self):
        for bad in ("Dockerfile", ".github/workflows/deploy.py", "tests/test_app.py", "policy/rules.py",
                    "baseline/check.py", "premortem/gate.py", "infra/main.py", "test_app.py", "conftest.py"):
            with self.subTest(bad=bad):
                self.assert_code("PATCH_PATH_DENIED", [dict(FIX, path=bad)], allowed=(bad,))

    def test_d10_path_not_in_allowlist(self):
        (self.root / "other.py").write_text(APP, encoding="utf-8")
        self.assert_code("PATCH_PATH_DENIED", [dict(FIX, path="other.py")])

    def test_d11_limits(self):
        small = Settings(max_patch_changed_lines=1)
        self.assert_code("PATCH_TOO_LARGE", [FIX], settings=small)
        tiny = Settings(max_patch_bytes=10)
        self.assert_code("PATCH_TOO_LARGE", [FIX], settings=tiny)
        paths = []
        for i in range(6):
            name = f"m{i}.py"
            (self.root / name).write_text(APP, encoding="utf-8")
            paths.append(name)
        self.assert_code("PATCH_TOO_LARGE", [dict(FIX, path=p) for p in paths], allowed=tuple(paths))

    def test_d12_overlapping_edits_rejected(self):
        overlap = [FIX, {"path": "app.py", "before": '"127.0.0.1"\nPORT', "after": '"0.0.0.0"\nPORT'}]
        self.assert_code("PATCH_AMBIGUOUS", overlap)

    def test_d13_binary_and_new_files_rejected(self):
        (self.root / "bin.py").write_bytes(b"HOST\x00")
        self.assert_code("PATCH_PATH_DENIED", [{"path": "bin.py", "before": "HOST", "after": "x"}], allowed=("bin.py",))
        self.assert_code("PATCH_PATH_DENIED", [dict(FIX, path="new.py")], allowed=("new.py",))

    def test_d11_nothing_applied_when_one_edit_is_bad(self):
        before = tree_hash(tree_listing(self.root)[0])
        with self.assertRaises(PremortemError):
            self.check([FIX, dict(FIX, path="Dockerfile")], allowed=("app.py", "Dockerfile"))
        self.assertEqual(tree_hash(tree_listing(self.root)[0]), before)

    def test_d14_copy_only_and_real_diff(self):
        before = tree_hash(tree_listing(self.root)[0])
        result = apply_to_copy(self.root, self.check([FIX]), Path(self.tmp.name) / "patched")
        self.assertEqual(tree_hash(tree_listing(self.root)[0]), before)
        self.assertIn('HOST = "127.0.0.1"', (self.root / "app.py").read_text(encoding="utf-8"))
        self.assertIn('HOST = "0.0.0.0"', (result.patched_root / "app.py").read_text(encoding="utf-8"))
        self.assertIn('-HOST = "127.0.0.1"', result.diff_text)
        self.assertIn('+HOST = "0.0.0.0"', result.diff_text)
        self.assertNotEqual(result.source_tree_sha256, result.patched_tree_sha256)
        self.assertEqual(result.changed_files, ("app.py",))

    def test_crlf_source_is_patched_without_joining_lines(self):
        (self.root / "app.py").write_bytes(APP.replace("\n", "\r\n").encode("utf-8"))
        result = apply_to_copy(self.root, self.check([FIX]), Path(self.tmp.name) / "patched")
        expected = APP.replace('HOST = "127.0.0.1"', 'HOST = "0.0.0.0"').replace("\n", "\r\n")
        self.assertEqual((result.patched_root / "app.py").read_bytes(), expected.encode("utf-8"))


if __name__ == "__main__":
    unittest.main()
