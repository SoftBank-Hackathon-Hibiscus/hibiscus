import copy
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from parity.summary_matrix import matrix_lines
from parity.__main__ import main


def sample():
    return {
        "passed": False,
        "replay": [
            {"condition": "none", "total": 3, "matched": 3},
            {"condition": "restart", "total": 3, "matched": 2},
            {"condition": "replace", "total": 3, "matched": 1},
        ],
        "mismatches": [
            {"condition": "restart", "index": 2, "request": "GET /posts", "expected": "200 …", "actual": "200 []", "related_fact": "/app/data.db"},
            {"condition": "replace", "index": 2, "request": "GET /posts"},
            {"condition": "replace", "index": 3, "request": "GET /uploads"},
        ],
    }


class SummaryMatrixTest(unittest.TestCase):
    def test_recorded_guestbook_result_is_seven_rows_with_one_extra_upload_failure(self):
        path = Path(__file__).parent.parent / "examples" / "summary_matrix_result.json"
        lines = matrix_lines(json.loads(path.read_text(encoding="utf-8")))
        rows = [line for line in lines if line.startswith("| ") and line.split(" | ")[0][2:].isdigit()]
        self.assertEqual(len(rows), 7)  # 조건별 불일치 13건을 서로 다른 요청 13개로 세지 않는다.
        self.assertIn("| 16 | GET /uploads | 일치 | 일치 | 불일치 |", lines)
        self.assertIn("replace: restart 대비 추가 불일치 요청 번호: 16", lines)

    def test_completed_conditions_show_only_mismatches_and_added_failures(self):
        result = sample()
        original = copy.deepcopy(result)
        lines = matrix_lines(result)
        self.assertIn("| 2 | GET /posts | 일치 | 불일치 | 불일치 |", lines)
        self.assertIn("| 3 | GET /uploads | 일치 | 일치 | 불일치 |", lines)
        self.assertFalse(any(line.startswith("| 1 |") for line in lines))
        self.assertIn("restart: none 대비 추가 불일치 요청 번호: 2", lines)
        self.assertIn("replace: restart 대비 추가 불일치 요청 번호: 3", lines)
        self.assertIn("원본 passed: false (배포 허가를 뜻하지 않습니다)", lines)
        self.assertEqual(result, original)
        self.assertNotIn("200 …", "\n".join(lines))

    def test_aborted_condition_does_not_guess_which_other_request_matched(self):
        result = sample()
        result["replay"][1].update(matched=1, error="stopped")
        lines = matrix_lines(result)
        self.assertIn("| 3 | GET /uploads | 일치 | 확인불가 | 불일치 |", lines)
        self.assertIn("| 2 | GET /posts | 일치 | 불일치 | 불일치 |", lines)
        self.assertTrue(all("확인불가" in line for line in lines if "추가 불일치" in line))

    def test_missing_condition_is_unknown_and_prevents_added_failure_inference(self):
        result = sample()
        result["replay"].pop(0)
        lines = matrix_lines(result)
        self.assertIn("| 2 | GET /posts | 확인불가 | 불일치 | 불일치 |", lines)
        self.assertTrue(all("확인불가" in line for line in lines if "추가 불일치" in line))

    def test_different_totals_do_not_imply_comparable_request_sets(self):
        result = sample()
        result["replay"][0].update(total=2, matched=2)
        lines = matrix_lines(result)
        self.assertIn("| 3 | GET /uploads | 확인불가 | 확인불가 | 불일치 |", lines)
        self.assertTrue(all("확인불가" in line for line in lines if "추가 불일치" in line))

    def test_all_matching_has_no_request_rows(self):
        result = sample()
        result["passed"] = True
        result["mismatches"] = []
        for entry in result["replay"]:
            entry["matched"] = entry["total"]
        lines = matrix_lines(result)
        self.assertIn("기록된 불일치 없음.", lines)
        self.assertIn("replace: restart 대비 추가 불일치 요청 번호: 없음", lines)

    def test_aborted_without_observed_failures_does_not_claim_success(self):
        result = {"passed": False, "replay": [{"condition": "none", "total": 3, "matched": 1, "error": "stopped"}], "mismatches": []}
        self.assertIn("기록된 불일치 없음 (전체 검증 통과를 뜻하지 않음).", matrix_lines(result))

    def test_request_label_is_one_escaped_table_cell(self):
        result = sample()
        result["mismatches"][2]["request"] = "GET /uploads|x\nnext"
        self.assertIn("| 3 | GET /uploads\\|x\\nnext | 일치 | 일치 | 불일치 |", matrix_lines(result))

    def test_malformed_fields_are_rejected_instead_of_rendering_false_matches(self):
        mutations = [
            lambda r: r.update(passed="false"),
            lambda r: r.update(passed=True),
            lambda r: r.update(replay=[]),
            lambda r: r.update(mismatches={}),
            lambda r: r["replay"].append(dict(r["replay"][0])),
            lambda r: r["replay"][0].update(condition="scale"),
            lambda r: r["replay"][0].update(condition=[]),
            lambda r: r["replay"][0].update(total=True),
            lambda r: r["replay"][0].update(total=0, matched=0),
            lambda r: r["replay"][0].update(total=3.0),
            lambda r: r["replay"][0].update(matched=True),
            lambda r: r["replay"][0].update(matched=-1),
            lambda r: r["replay"][0].update(matched=4),
            lambda r: r["replay"][1].update(matched=3),
            lambda r: r["replay"][1].update(error=None),
            lambda r: r["replay"][1].update(error=""),
            lambda r: r["replay"][1].update(error="stopped", matched=3),
            lambda r: r["mismatches"].append(dict(r["mismatches"][0])),
            lambda r: r["mismatches"][0].update(condition="unknown"),
            lambda r: r["mismatches"][0].update(index=True),
            lambda r: r["mismatches"][0].update(index=0),
            lambda r: r["mismatches"][0].update(index=4),
            lambda r: r["mismatches"][0].update(request="GET /different"),
            lambda r: r["mismatches"][0].update(request=None),
            lambda r: r["replay"].__setitem__(0, None),
            lambda r: r["mismatches"].__setitem__(0, None),
        ]
        for number, mutate in enumerate(mutations):
            with self.subTest(case=number):
                result = sample()
                mutate(result)
                with self.assertRaises(ValueError):
                    matrix_lines(result)

    def test_non_object_result_is_rejected(self):
        for value in (None, [], True, "result"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                matrix_lines(value)


class SummaryMatrixCommandTest(unittest.TestCase):
    def test_cli_displays_real_fixture_without_changing_input(self):
        path = Path(__file__).parent.parent / "examples" / "summary_matrix_result.json"
        before = path.read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["summary", str(path), "--matrix"])
        self.assertEqual(code, 0)
        self.assertIn("| 16 | GET /uploads | 일치 | 일치 | 불일치 |", output.getvalue())
        self.assertEqual(path.read_bytes(), before)

    def test_cli_rejects_inconsistent_input_without_printing_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "invalid.json"
            result = sample()
            result["mismatches"][0]["index"] = 4
            path.write_text(json.dumps(result), encoding="utf-8")
            output, errors = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                code = main(["summary", str(path), "--matrix"])
            self.assertEqual(code, 2)
            self.assertEqual(output.getvalue(), "")
            self.assertIn("범위", errors.getvalue())

    def test_original_summary_still_includes_response_details(self):
        path = Path(__file__).parent.parent / "examples" / "summary_matrix_result.json"
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["summary", str(path)])
        self.assertEqual(code, 0)
        self.assertIn("none: 20/20, restart: 14/20, replace: 13/20, 불일치 13건", output.getvalue())
        self.assertIn("기대 200", output.getvalue())
        self.assertNotIn("| 요청 번호 |", output.getvalue())
