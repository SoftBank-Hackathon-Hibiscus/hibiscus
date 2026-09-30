"""조건 실행 규칙 (ACCEPTANCE B01, B05, B06, B08, B11, B13, C15). 가짜 Docker로 실행한다."""

import itertools
import tempfile
import unittest
from pathlib import Path

from premortem.evidence import EvidenceLog
from premortem.lifecycle import ConditionRunner, is_loopback, parse_listen_addresses
from premortem.scenarios import get_scenario

from tests.premortem.fakes import IMAGE_ID, LOOPBACK_LISTEN, FakeDocker, FakeReplay

CORE = ["none", "restart", "replace"]


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def make(self, docker, replay, ready=True, scenario="state-loss"):
        evidence = EvidenceLog("run-1", Path(self.tmp.name), 2_000_000)
        ticks = itertools.count()
        runner = ConditionRunner(docker, evidence, replay, get_scenario(scenario), "run-1", IMAGE_ID, 6,
                                 http_check=lambda url: ready, sleep=lambda s: None, clock=lambda: next(ticks) * 0.5)
        return runner, evidence

    def test_state_loss_pattern(self):
        docker = FakeDocker()
        runner, _ = self.make(docker, FakeReplay(docker))
        results = {r["name"]: r for r in runner.run_all(CORE, [3])}
        self.assertEqual({n: r["status"] for n, r in results.items()},
                         {"none": "passed", "restart": "passed", "replace": "failed"})
        self.assertEqual([m["request_index"] for m in results["replace"]["mismatches"]], [4, 5])
        self.assertEqual(docker.containers, {})  # 조건마다 자기 컨테이너를 지움

    def test_b01_fault_injected_once_after_request_3(self):
        docker = FakeDocker()
        runner, _ = self.make(docker, FakeReplay(docker))
        runner.run_all(["none", "restart"], [3])
        self.assertEqual([c for c in docker.calls if c[0] == "restart"].__len__(), 1)

    def test_b05_restart_keeps_same_container(self):
        docker = FakeDocker()
        runner, evidence = self.make(docker, FakeReplay(docker))
        runner.run_all(["none", "restart"], [3])
        restarted = [c[1] for c in docker.calls if c[0] == "restart"][0]
        created_for_restart = [c[2] for c in docker.calls if c[0] == "create" and c[1] == "restart"]
        self.assertEqual(created_for_restart, [restarted])
        self.assertIn("restart-lifecycle-3", evidence.by_id())

    def test_b06_replace_makes_new_container_from_same_image(self):
        docker = FakeDocker()
        runner, evidence = self.make(docker, FakeReplay(docker))
        runner.run_all(CORE, [3])
        replace_ids = [c[2] for c in docker.calls if c[0] == "create" and c[1] == "replace"]
        self.assertEqual(len(replace_ids), 2)
        self.assertNotEqual(replace_ids[0], replace_ids[1])
        self.assertIn("같은 이미지", evidence.by_id()["replace-lifecycle-3"]["sanitized_summary"])

    def test_replace_with_same_id_is_an_error(self):
        docker = FakeDocker(same_id_on_replace=True)
        runner, _ = self.make(docker, FakeReplay(docker))
        results = {r["name"]: r for r in runner.run_all(CORE, [3])}
        self.assertEqual(results["replace"]["status"], "error")

    def test_b08_no_data_restored_after_replace(self):
        docker = FakeDocker()
        runner, _ = self.make(docker, FakeReplay(docker))
        runner.run_all(CORE, [3])
        # 교체 뒤 컨테이너 안에 무언가를 복사하거나 실행해서 데이터를 되살리지 않는다
        self.assertNotIn("exec", [c[0] for c in docker.calls])

    def test_b11_c15_readiness_failure_is_diagnosed_and_rest_skipped(self):
        docker = FakeDocker()
        runner, evidence = self.make(docker, FakeReplay(docker), ready=False, scenario="binding")
        results = {r["name"]: r for r in runner.run_all(CORE, [3])}
        self.assertEqual(results["none"]["status"], "failed")
        self.assertIn("binding 후보", results["none"]["reason"])
        self.assertEqual(results["none"]["executed_count"], 0)
        self.assertEqual((results["restart"]["status"], results["replace"]["status"]), ("skipped", "skipped"))
        self.assertIn("127.0.0.1:8080", evidence.by_id()["none-listen_socket-na"]["sanitized_summary"])

    def test_b11_timeout_alone_is_not_called_binding(self):
        docker = FakeDocker(internal_ok=False, proc_net="")
        runner, _ = self.make(docker, FakeReplay(docker), ready=False, scenario="binding")
        result = runner.run_all(["none"], [3])[0]
        self.assertEqual(result["reason"], "readiness_failed: 원인 미확정")

    def test_listen_on_other_port_is_not_called_binding(self):
        # 앱이 기대한 포트가 아닌 곳에서 열려 있으면 바인딩 후보라고 하지 않는다
        docker = FakeDocker()
        runner, _ = self.make(docker, FakeReplay(docker), ready=False, scenario="state-loss")
        result = runner.run_all(["none"], [3])[0]
        self.assertEqual(result["reason"], "readiness_failed: 원인 미확정")

    def test_b11_exited_container(self):
        docker = FakeDocker(running=False)
        runner, _ = self.make(docker, FakeReplay(docker), ready=False)
        result = runner.run_all(["none"], [3])[0]
        self.assertIn("컨테이너 종료", result["reason"])

    def test_b13_interrupt_still_removes_own_container(self):
        docker = FakeDocker()
        runner, _ = self.make(docker, FakeReplay(docker, raise_on_replay=KeyboardInterrupt()))
        with self.assertRaises(KeyboardInterrupt):
            runner.run_all(CORE, [3])
        self.assertEqual(docker.containers, {})
        self.assertEqual(runner.tracked, [c[2] for c in docker.calls if c[0] == "create"])

    def test_b03_zero_requests_never_pass(self):
        docker = FakeDocker()
        evidence = EvidenceLog("run-1", Path(self.tmp.name), 2_000_000)
        runner = ConditionRunner(docker, evidence, FakeReplay(docker, count=0), get_scenario("state-loss"),
                                 "run-1", IMAGE_ID, 0, http_check=lambda url: True, sleep=lambda s: None)
        self.assertEqual({r["status"] for r in runner.run_all(CORE, [])}, {"inconclusive"})

    def test_b04_one_request_cannot_inject_fault(self):
        docker = FakeDocker()
        evidence = EvidenceLog("run-1", Path(self.tmp.name), 2_000_000)
        runner = ConditionRunner(docker, evidence, FakeReplay(docker, count=1), get_scenario("state-loss"),
                                 "run-1", IMAGE_ID, 1, http_check=lambda url: True, sleep=lambda s: None)
        results = {r["name"]: r["status"] for r in runner.run_all(CORE, [])}
        self.assertEqual(results, {"none": "passed", "restart": "inconclusive", "replace": "inconclusive"})


class ListenParseTest(unittest.TestCase):
    def test_parses_ipv4_and_ipv6(self):
        text = LOOPBACK_LISTEN + ("   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A\n"
                                  "   1: 00000000:1F90 00000000:0000 0A\n")
        self.assertEqual(parse_listen_addresses(text, 8080), ["0.0.0.0:8080", "127.0.0.1:8080", "[::1]:8080"])

    def test_loopback_detection(self):
        self.assertTrue(is_loopback("127.0.0.1:8080"))
        self.assertTrue(is_loopback("[::1]:8080"))
        self.assertFalse(is_loopback("0.0.0.0:8080"))


if __name__ == "__main__":
    unittest.main()
