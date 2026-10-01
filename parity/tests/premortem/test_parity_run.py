"""윤선님 parity 재생기로 실제 앱을 검사하는 경로(run 명령). 가짜 Docker로 실행한다."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from premortem import runner as runner_mod
from premortem.adapters.parity_adapter import load_parity_adapter
from premortem.cli import main
from premortem.config import CORE_CONDITIONS, Settings
from premortem.errors import EXIT_ERROR, PremortemError
from premortem.process import CommandResult
from premortem.runner import execute_run
from premortem.scenarios import Scenario

from tests.premortem.fakes import IMAGE_ID, FakeDocker, FakeReplay, FakeRunner


class BuildingDocker(FakeDocker):
    def build(self, context, tag, labels):
        self.calls.append(("build", tag))
        return IMAGE_ID

    def image_platform(self, image_id):
        return "linux/amd64"


class ParityLikeReplay(FakeReplay):
    backend = "parity"


def no_git(args):
    return CommandResult(tuple(args), 128, "", "not a git repository")


class LoaderTest(unittest.TestCase):
    def test_loader_returns_parity_port(self):
        self.assertEqual(load_parity_adapter().backend, "parity")

    def test_loader_reports_missing_parity(self):
        with mock.patch.dict(sys.modules, {"parity.premortem_adapter": None}), \
                self.assertRaises(PremortemError) as caught:
            load_parity_adapter()
        self.assertEqual(caught.exception.code, "PARITY_ADAPTER_MISSING")


class RunLabelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.src = root / "app"
        self.src.mkdir()
        (self.src / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
        (self.src / "app.py").write_text("print('hi')\n", encoding="utf-8")
        self.session = root / "session.jsonl"
        self.session.write_text("".join(json.dumps({"index": i}) + "\n" for i in range(1, 7)), encoding="utf-8")
        self.noise = root / "session.noise.json"
        self.noise.write_text('{"rules": []}', encoding="utf-8")
        self.run_root = root / "runs"

    def run_with(self, replay_class, run_id=None):
        docker = BuildingDocker()
        scenario = Scenario("guestbook", "test", self.src, self.session, self.noise, 8080, "/healthz", 0.5,
                            (3,), CORE_CONDITIONS, (), {})
        real = runner_mod.ConditionRunner
        ready = lambda *a, **k: real(*a, http_check=lambda url: True, sleep=lambda s: None, **k)  # noqa: E731
        with mock.patch.object(runner_mod, "ConditionRunner", ready):
            result = execute_run(scenario, self.src, "pretest", None, Settings(), docker, replay_class(docker),
                                 FakeRunner(no_git), self.run_root, run_id=run_id)
        return result, docker

    def test_pipeline_run_id_is_used_as_is(self):
        result, _ = self.run_with(ParityLikeReplay, run_id="pipe-20261001-1")
        self.assertEqual((result.run_id, result.env_report["run_id"], result.run_dir.name), ("pipe-20261001-1",) * 3)

    def test_same_run_id_is_not_overwritten(self):
        self.run_with(ParityLikeReplay, run_id="pipe-1")
        with self.assertRaises(PremortemError) as caught:
            self.run_with(ParityLikeReplay, run_id="pipe-1")
        self.assertEqual(caught.exception.code, "RUN_EXISTS")

    def test_parity_run_is_marked_as_team_result(self):
        result, _ = self.run_with(ParityLikeReplay)
        report = result.env_report
        self.assertEqual((report["replay_backend"], report["team_parity_integrated"]), ("parity", True))
        self.assertIn("parity 재생기", report["note"])
        self.assertFalse(any("reference" in b for b in report["gate"]["handoff_blockers"]))
        self.assertTrue(result.manifest["image"]["reference"].startswith("premortem/guestbook:"))
        self.assertEqual({c["name"]: c["status"] for c in report["conditions"]},
                         {"none": "passed", "restart": "passed", "replace": "failed"})

    def test_reference_run_keeps_sample_labels(self):
        result, _ = self.run_with(FakeReplay)
        report = result.env_report
        self.assertEqual((report["replay_backend"], report["team_parity_integrated"]), ("reference", False))
        self.assertTrue(any("reference" in b for b in report["gate"]["handoff_blockers"]))
        self.assertTrue(result.manifest["image"]["reference"].startswith("premortem-demo/guestbook:"))


class RunCommandInputTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / "app").mkdir()
        (root / "session.jsonl").write_text("{}\n", encoding="utf-8")
        (root / "session.noise.json").write_text('{"rules": []}', encoding="utf-8")
        self.base = ["run", "--app", str(root / "app"), "--record", str(root / "session.jsonl")]
        self.root = root

    def test_missing_paths_are_rejected_before_docker(self):
        self.assertEqual(main(["run", "--app", str(self.root / "nope"), "--record", str(self.root / "nope.jsonl")]),
                         EXIT_ERROR)

    def test_bad_name_is_rejected(self):
        self.assertEqual(main([*self.base, "--name", "Bad Name"]), EXIT_ERROR)

    def test_bad_after_is_rejected(self):
        self.assertEqual(main([*self.base, "--after", "ten"]), EXIT_ERROR)

    def test_bad_run_id_is_rejected_before_docker(self):
        self.assertEqual(main([*self.base, "--run-id", "../x"]), EXIT_ERROR)


if __name__ == "__main__":
    unittest.main()
