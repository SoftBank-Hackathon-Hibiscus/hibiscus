"""윤선님 parity 재생기로 실제 앱을 검사하는 경로(run 명령). 가짜 Docker로 실행한다."""

import itertools
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from premortem import runner as runner_mod
from premortem.adapters.parity_adapter import load_parity_adapter
from premortem.cli import main
from premortem.config import CORE_CONDITIONS, Settings
from premortem.errors import EXIT_ERROR, PremortemError
from premortem.evidence import EvidenceLog
from premortem.gate import overall_status
from premortem.lifecycle import ConditionRunner
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


class ReadinessReplayTest(unittest.TestCase):
    """실제 HTTP·parity 재생기에서 조건 주입 후 health 실패와 부분 결과를 확인한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.health_status = 200
        self.body_mismatch = False
        self.requests = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == "/healthz":
                    status, body = test.health_status, b"health"
                else:
                    test.requests.append(self.path)
                    status = 200
                    body = json.dumps({"ok": not (test.body_mismatch and self.path == "/request/1")}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.root = Path(self.tmp.name)
        self.session = self.root / "session.jsonl"
        records = [{"index": i,
                    "request": {"method": "GET", "path": f"/request/{i}", "headers": [],
                                "body": "", "body_encoding": "utf8"},
                    "response": {"status": 200, "headers": [["Content-Type", "application/json"]],
                                 "body": '{"ok": true}', "body_encoding": "utf8"}}
                   for i in range(1, 4)]
        self.session.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
        self.noise = self.root / "session.noise.json"
        self.noise.write_text('{"rules": []}', encoding="utf-8")

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_condition(self, condition, health_after, body_mismatch=False):
        test = self
        self.requests.clear()

        class Docker(FakeDocker):
            def create(self, image_id, run_id, name, port, sequence):
                replacing = name == "replace" and any(c[0] == "create" and c[1] == name for c in self.calls)
                test.health_status = health_after if replacing else 200
                test.body_mismatch = body_mismatch and name != "none"
                return super().create(image_id, run_id, name, port, sequence)

            def host_port(self, container_id, port):
                return test.server.server_address[1]

            def restart(self, container_id, run_id):
                super().restart(container_id, run_id)
                test.health_status = health_after

        docker = Docker(internal_ok=health_after == 200, proc_net="")
        run_id = f"{condition}-{health_after}-{int(body_mismatch)}"
        run_dir = self.root / run_id
        run_dir.mkdir()
        evidence = EvidenceLog(run_id, run_dir, 2_000_000)
        required = ["none", condition]
        scenario = Scenario("readiness", "test", self.root, self.session, self.noise, 8080, "/healthz", 0.1,
                            (2,), tuple(required), (), {})
        ticks = itertools.count()
        runner = ConditionRunner(docker, evidence, load_parity_adapter(), scenario, run_id, IMAGE_ID, 3,
                                 sleep=lambda s: None, clock=lambda: next(ticks) * 0.01)
        results = runner.run_all(required, [2])
        self.assertEqual(results[0]["status"], "passed")
        self.assertEqual(docker.containers, {})
        return results, evidence

    def test_restart_and_replace_stop_when_health_returns_503(self):
        for condition in ("restart", "replace"):
            with self.subTest(condition=condition):
                results, evidence = self.run_condition(condition, 503)
                failed = results[1]
                self.assertEqual(failed["status"], "failed")
                self.assertEqual(overall_status(["none", condition], results), "failed")
                self.assertEqual((failed["expected_count"], failed["executed_count"], failed["matched_count"]),
                                 (3, 2, 2))
                self.assertEqual(self.requests, ["/request/1", "/request/2", "/request/3",
                                                 "/request/1", "/request/2"])
                self.assertEqual([(m["request_index"], m["kind"]) for m in failed["mismatches"]], [(3, "readiness")])
                self.assertIn("readiness_failed", failed["reason"])
                self.assertTrue(all(eid in evidence.by_id() for m in failed["mismatches"] for eid in m["evidence_ids"]))

    def test_readiness_failure_preserves_prior_http_mismatches(self):
        for condition in ("restart", "replace"):
            with self.subTest(condition=condition):
                results, _ = self.run_condition(condition, 503, body_mismatch=True)
                failed = results[1]
                self.assertEqual(failed["status"], "failed")
                self.assertEqual((failed["expected_count"], failed["executed_count"], failed["matched_count"]),
                                 (3, 2, 1))
                self.assertEqual([(m["request_index"], m["kind"]) for m in failed["mismatches"]],
                                 [(1, "body"), (3, "readiness")])

    def test_restart_and_replace_continue_when_health_returns_200(self):
        for condition in ("restart", "replace"):
            with self.subTest(condition=condition):
                results, _ = self.run_condition(condition, 200)
                passed = results[1]
                self.assertEqual(overall_status(["none", condition], results), "passed")
                self.assertEqual((passed["expected_count"], passed["executed_count"], passed["matched_count"]),
                                 (3, 3, 3))
                self.assertEqual(passed["mismatches"], [])
                self.assertEqual(self.requests, ["/request/1", "/request/2", "/request/3"] * 2)


if __name__ == "__main__":
    unittest.main()
