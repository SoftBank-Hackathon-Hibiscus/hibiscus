"""M0: CLI, 실행 ID·경로, JSON 저장, 명령 실행기. Docker·AI·클라우드 없이 실행된다."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from premortem.errors import PremortemError
from premortem.jsonio import loads_strict, write_json_atomic
from premortem.paths import create_run_dir, new_run_id, resolve_inside, safe_relative, validate_run_id
from premortem.process import SubprocessRunner, check_args

REPO_ROOT = Path(__file__).resolve().parents[2]


class CliTest(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-m", "premortem", *args], cwd=REPO_ROOT,
                              capture_output=True, text=True, encoding="utf-8", timeout=60)

    def test_help_lists_commands(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("doctor", result.stdout)

    def test_doctor_json_is_single_json_on_stdout(self):
        result = self.run_cli("doctor", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        for key in ("python", "docker_cli", "ai_credentials", "team_replay"):
            self.assertIn(report["checks"][key]["status"], {"available", "missing", "incompatible", "unchecked"})

    def test_doctor_never_prints_key_value(self):
        env = dict(os.environ, ANTHROPIC_API_KEY="test-only-secret-value")
        result = subprocess.run([sys.executable, "-m", "premortem", "doctor", "--json"], cwd=REPO_ROOT,
                                capture_output=True, text=True, encoding="utf-8", timeout=60, env=env)
        self.assertNotIn("test-only-secret-value", result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["checks"]["ai_credentials"]["status"], "available")

    def test_unknown_command_is_input_error(self):
        self.assertNotEqual(self.run_cli("no-such-command").returncode, 0)


class RunIdAndPathTest(unittest.TestCase):
    def test_a03_traversal_run_ids_rejected(self):
        for bad in ("../outside", ".", "..", "a/b", "", "x" * 65, "a b"):
            with self.subTest(bad=bad), self.assertRaises(PremortemError):
                validate_run_id(bad)

    def test_a03_no_file_created_outside_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "runs"
            with self.assertRaises(PremortemError):
                create_run_dir(root, "../outside")
            self.assertFalse((Path(tmp) / "outside").exists())

    def test_a04_existing_run_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = create_run_dir(Path(tmp), "run-1")
            (run_dir / "env_report.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(PremortemError) as caught:
                create_run_dir(Path(tmp), "run-1")
            self.assertEqual(caught.exception.code, "RUN_EXISTS")
            self.assertEqual((run_dir / "env_report.json").read_text(encoding="utf-8"), "{}")

    def test_generated_run_id_is_valid(self):
        self.assertEqual(validate_run_id(new_run_id("state-loss-pre")).split("-")[0], "state")

    def test_relative_path_rules(self):
        for bad in ("/etc/passwd", "../x", "a/../b", "C:/x", "a\\b", "\\\\server\\share", "./a", "a//b"):
            with self.subTest(bad=bad), self.assertRaises(PremortemError):
                safe_relative(bad)
        self.assertEqual(str(safe_relative("app/app.py")), "app/app.py")

    @unittest.skipIf(os.name == "nt", "symlink 생성 권한이 필요한 환경")
    def test_a05_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            outside = Path(tmp) / "outside.txt"
            outside.write_text("secret", encoding="utf-8")
            (root / "link.txt").symlink_to(outside)
            with self.assertRaises(PremortemError):
                resolve_inside(root, "link.txt")


class JsonTest(unittest.TestCase):
    def test_duplicate_keys_and_nan_rejected(self):
        with self.assertRaises(PremortemError):
            loads_strict('{"a": 1, "a": 2}')
        with self.assertRaises(PremortemError):
            loads_strict('{"a": NaN}')

    def test_atomic_write_leaves_no_temp_file_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "out.json"
            write_json_atomic(target, {"ok": True})
            with self.assertRaises(ValueError):
                write_json_atomic(target, {"bad": float("nan")})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"ok": True})
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["out.json"])


class CommandRunnerTest(unittest.TestCase):
    def test_only_allowed_executables(self):
        for bad in (["bash", "-c", "rm -rf /"], ["sh"], [], ["docker", 1]):
            with self.subTest(bad=bad), self.assertRaises(PremortemError):
                check_args(bad)

    def test_runner_does_not_pass_ai_keys(self):
        # git 자체는 환경을 출력하지 않으므로, 실행기의 환경 목록에 키가 없는지 확인한다.
        from premortem import process
        self.assertNotIn("ANTHROPIC_API_KEY", process._ENV_PASSTHROUGH)
        self.assertNotIn("OPENAI_API_KEY", process._ENV_PASSTHROUGH)
        result = SubprocessRunner().run(["git", "--version"], 10)
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
