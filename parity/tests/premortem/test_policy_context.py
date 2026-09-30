"""정책 requires 읽기 (ACCEPTANCE D15~D18). 류진님 개발일지의 형식을 흉내 낸 합성 plan으로 검사한다."""

import tempfile
import unittest
from pathlib import Path

from premortem.errors import PremortemError
from premortem.jsonio import write_json_atomic
from premortem.policy_context import load_requires, unsupported


class PolicyContextTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def plan(self, **fields):
        path = Path(self.tmp.name) / "plan.json"
        data = {"run_id": "run-1", "decision": "allow", "targets": ["local"], "requires": []}
        data.update(fields)
        write_json_atomic(path, data)
        return path

    def test_d15_local_only_target_is_kept_as_candidate_not_permission(self):
        requires = load_requires(self.plan(requires=[{"id": "managed_db", "hint": "영속 DB로", "rule_id": "R5",
                                                      "allowed_targets": ["local"]}]), "run-1", None)
        self.assertEqual(requires[0]["allowed_targets"], ["local"])
        self.assertIn("현재 배포 허가가 아니", requires[0]["meaning_of_allowed_targets"])

    def test_d16_other_run_or_digest_is_rejected(self):
        with self.assertRaises(PremortemError) as caught:
            load_requires(self.plan(run_id="run-2"), "run-1", None)
        self.assertEqual(caught.exception.code, "POLICY_CONTEXT_MISMATCH")
        with self.assertRaises(PremortemError):
            load_requires(self.plan(digest="sha256:" + "a" * 64), "run-1", "sha256:" + "b" * 64)

    def test_d17_unknown_requirement_is_kept_for_a_person(self):
        requires = load_requires(self.plan(requires=[{"id": "quantum_shield", "hint": "?", "rule_id": "R99",
                                                      "allowed_targets": []}]), "run-1", None)
        self.assertEqual(requires[0]["id"], "quantum_shield")
        self.assertEqual(unsupported(requires), ["quantum_shield"])
        self.assertIn("사람이 처리", requires[0]["handling"])

    def test_d18_several_requirements_are_not_merged_into_permission(self):
        requires = load_requires(self.plan(requires=[
            {"id": "managed_db", "rule_id": "R5", "allowed_targets": ["local", "cloud_run"]},
            {"id": "object_storage", "rule_id": "R6", "allowed_targets": ["local"]}]), "run-1", None)
        self.assertEqual([r["id"] for r in requires], ["managed_db", "object_storage"])
        self.assertTrue(all("정책을 다시 평가" in r["meaning_of_allowed_targets"] for r in requires))
        self.assertFalse(any("deploy" in key for r in requires for key in r))


if __name__ == "__main__":
    unittest.main()
