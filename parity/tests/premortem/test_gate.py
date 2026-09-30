"""판정 규칙: 거짓 통과를 막는 사례 (ACCEPTANCE C01~C05, B02~B04)."""

import unittest

from premortem.errors import PremortemError
from premortem.gate import check_condition, condition_status, fault_positions, overall_status

CORE = ["none", "restart", "replace"]


def cond(name, status, expected=6, executed=6, matched=6, mismatches=None):
    return {"name": name, "status": status, "expected_count": expected, "executed_count": executed,
            "matched_count": matched, "mismatches": mismatches or [], "evidence_ids": [], "reason": None}


def mismatch(index):
    return {"request_index": index, "kind": "body", "summary": "x", "evidence_ids": ["e"]}


class OverallTest(unittest.TestCase):
    def test_all_passed(self):
        self.assertEqual(overall_status(CORE, [cond(n, "passed") for n in CORE]), "passed")

    def test_c01_replace_failure_fails_everything(self):
        conditions = [cond("none", "passed"), cond("restart", "passed"),
                      cond("replace", "failed", matched=4, mismatches=[mismatch(4), mismatch(5)])]
        self.assertEqual(overall_status(CORE, conditions), "failed")

    def test_c02_missing_required_condition_is_not_pass(self):
        self.assertEqual(overall_status(CORE, [cond("none", "passed"), cond("restart", "passed")]), "inconclusive")

    def test_c02_duplicate_condition_rejected(self):
        with self.assertRaises(PremortemError):
            overall_status(CORE, [cond("none", "passed"), cond("none", "passed")])

    def test_c03_skipped_or_inconclusive_required_is_not_pass(self):
        for status in ("skipped", "inconclusive"):
            with self.subTest(status=status):
                conditions = [cond("none", "passed"), cond("restart", "passed"),
                              cond("replace", status, executed=0, matched=0)]
                self.assertEqual(overall_status(CORE, conditions), "inconclusive")

    def test_failed_wins_over_skipped(self):
        conditions = [cond("none", "failed", matched=5, mismatches=[mismatch(2)]),
                      cond("restart", "skipped", executed=0, matched=0), cond("replace", "skipped", executed=0, matched=0)]
        self.assertEqual(overall_status(CORE, conditions), "failed")

    def test_error_wins(self):
        conditions = [cond("none", "passed"), cond("restart", "error", executed=3, matched=3),
                      cond("replace", "failed", matched=4, mismatches=[mismatch(4)])]
        self.assertEqual(overall_status(CORE, conditions), "error")

    def test_none_is_always_required(self):
        with self.assertRaises(PremortemError):
            overall_status(["restart"], [cond("restart", "passed")])

    def test_high_total_match_rate_does_not_hide_one_failure(self):
        conditions = [cond("none", "passed", 1000, 1000, 1000), cond("restart", "passed", 1000, 1000, 1000),
                      cond("replace", "failed", 1000, 1000, 999, [mismatch(10)])]
        self.assertEqual(overall_status(CORE, conditions), "failed")


class ConditionTest(unittest.TestCase):
    def test_c04_counter_order(self):
        for expected, executed, matched in ((6, 5, 6), (6, 7, 6), (6, 6, -1)):
            with self.subTest(e=expected, x=executed, m=matched), self.assertRaises(PremortemError):
                check_condition(cond("none", "failed", expected, executed, matched))

    def test_c05_zero_zero_cannot_pass(self):
        with self.assertRaises(PremortemError):
            check_condition(cond("none", "passed", 0, 0, 0))
        self.assertEqual(condition_status(0, 0, 0, []), "inconclusive")

    def test_partial_run_cannot_pass(self):
        self.assertEqual(condition_status(6, 3, 3, []), "failed")
        with self.assertRaises(PremortemError):
            check_condition(cond("none", "passed", 6, 3, 3))

    def test_mismatch_index_must_be_recorded_request(self):
        with self.assertRaises(PremortemError):
            check_condition(cond("replace", "failed", 6, 6, 5, [mismatch(7)]))


class FaultPositionTest(unittest.TestCase):
    def test_b01_valid_position(self):
        self.assertEqual(fault_positions([3], 6), [3])

    def test_b02_invalid_positions_rejected_before_running(self):
        for bad in ([0], [6], [3, 3], ["3"], [True], [-1]):
            with self.subTest(bad=bad), self.assertRaises(PremortemError):
                fault_positions(bad, 6)

    def test_default_is_half(self):
        self.assertEqual(fault_positions([], 7), [3])

    def test_b03_b04_too_few_requests(self):
        self.assertEqual(fault_positions([3], 1), [])
        self.assertEqual(fault_positions([], 0), [])


if __name__ == "__main__":
    unittest.main()
