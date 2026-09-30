"""인계 묶음 무결성과 증거 상한 (ACCEPTANCE E07, C16)."""

import itertools
import json
import tempfile
import unittest
from pathlib import Path

from premortem.errors import PremortemError
from premortem.evidence import EvidenceLog
from premortem.handoff import verify_handoff, write_handoff
from premortem.jsonio import write_json_atomic
from premortem.lifecycle import ConditionRunner
from premortem.scenarios import get_scenario

from tests.premortem.fakes import IMAGE_ID, FakeDocker, FakeReplay


class HandoffTest(unittest.TestCase):
    def test_e07_changed_file_breaks_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp)
            write_json_atomic(run / "env_report.json", {"run_id": "run-1", "gate": {"handoff_blockers": ["팀 연동 전"]}})
            (run / "evidence.jsonl").write_text("{}\n", encoding="utf-8")
            bundle = write_handoff(run)
            self.assertEqual((bundle["mode"], bundle["ready_for_policy"]), ("pending_team_integration", False))
            verify_handoff(run)
            (run / "evidence.jsonl").write_text("{\"changed\": true}\n", encoding="utf-8")
            with self.assertRaises(PremortemError) as caught:
                verify_handoff(run)
            self.assertEqual(caught.exception.code, "HANDOFF_INVALID")


class EvidenceLimitTest(unittest.TestCase):
    def test_c16_truncated_evidence_is_not_a_silent_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            docker = FakeDocker()
            evidence = EvidenceLog("run-1", Path(tmp), max_bytes=10)
            ticks = itertools.count()
            runner = ConditionRunner(docker, evidence, FakeReplay(docker), get_scenario("state-loss"), "run-1",
                                     IMAGE_ID, 6, http_check=lambda url: True, sleep=lambda s: None,
                                     clock=lambda: next(ticks) * 0.5)
            result = runner.run_all(["none"], [3])[0]
            summaries = [r["sanitized_summary"] for r in evidence.records]
        self.assertEqual(result["status"], "inconclusive")
        self.assertIn("evidence_truncated", result["reason"])
        self.assertTrue(any("상한" in s for s in summaries))

    def test_evidence_ids_are_repeatable(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            first, second = EvidenceLog("r", Path(a), 10_000), EvidenceLog("r", Path(b), 10_000)
            ids = [[log.add("replace", "http_mismatch", "x", request_index=4),
                    log.add("replace", "http_mismatch", "y", request_index=4)] for log in (first, second)]
        self.assertEqual(ids[0], ids[1])
        self.assertEqual(ids[0], ["replace-http_mismatch-4", "replace-http_mismatch-4-2"])


if __name__ == "__main__":
    unittest.main()
