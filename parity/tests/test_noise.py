"""노이즈 판정 단위 테스트: 후보(candidates)와 적용 규칙(rules)의 구분."""
import json
import os
import tempfile
import unittest

from parity import noise
from parity.record import encode_body
from parity.replay import Response

JSON = [["Content-Type", "application/json"]]
TEXT = [["Content-Type", "text/html"]]


def rec(index, status, body, headers=JSON):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    text, enc = encode_body(data)
    return {"index": index,
            "request": {"method": "GET", "path": f"/r{index}", "headers": [], "body": "", "body_encoding": "utf8"},
            "response": {"status": status, "headers": headers, "body": text, "body_encoding": enc}}


def resp(status, body, headers=JSON):
    return Response(status, headers, body if isinstance(body, bytes) else json.dumps(body).encode())


def decisions(result):
    return {(c["index"], c["field"]): (c["decision"], c["reason"]) for c in result["candidates"]}


class AnalyzeTest(unittest.TestCase):
    def test_recorded_200_replayed_500_twice_applies_nothing(self):
        """사용자 보고 사례: 기록 200, 두 재생 모두 500 → 적용 규칙 0개."""
        records = [rec(1, 200, {"ok": True, "t": "a"})]
        result = noise.analyze(records, [[resp(500, {"error": "boom"})], [resp(500, {"error": "boom"})]])
        self.assertEqual(result["rules"], [])
        d = decisions(result)
        self.assertEqual(d[(1, "status")], ("rejected", "status_code"))
        self.assertEqual(d[(1, "body.ok")], ("rejected", "missing_field"))
        self.assertTrue(all(dec == "rejected" for dec, _ in d.values()))

    def test_value_varying_between_runs_is_applied(self):
        records = [rec(1, 201, {"id": 1, "created_at": "t0"})]
        result = noise.analyze(records, [[resp(201, {"id": 1, "created_at": "t1"})],
                                         [resp(201, {"id": 1, "created_at": "t2"})]])
        self.assertEqual(result["rules"], [{"index": 1, "request": "GET /r1", "fields": ["body.created_at"]}])
        self.assertEqual(decisions(result), {(1, "body.created_at"): ("applied", "varies_between_runs")})

    def test_list_items_are_generalized(self):
        records = [rec(1, 200, [{"t": "a"}, {"t": "b"}])]
        result = noise.analyze(records, [[resp(200, [{"t": "c"}, {"t": "d"}])],
                                         [resp(200, [{"t": "e"}, {"t": "f"}])]])
        self.assertEqual(result["rules"][0]["fields"], ["body[*].t"])

    def test_consistent_difference_is_not_noise(self):
        """재생끼리는 같은데 기록과만 다르다 → 실제 차이."""
        records = [rec(1, 200, {"version": "1.0"})]
        result = noise.analyze(records, [[resp(200, {"version": "2.0"})], [resp(200, {"version": "2.0"})]])
        self.assertEqual(result["rules"], [])
        self.assertEqual(decisions(result)[(1, "body.version")], ("rejected", "consistent_difference"))

    def test_flaky_status_is_not_noise(self):
        records = [rec(1, 200, {"ok": True})]
        result = noise.analyze(records, [[resp(200, {"ok": True})], [resp(503, {"ok": True})]])
        self.assertEqual(result["rules"], [])
        self.assertEqual(decisions(result)[(1, "status")], ("rejected", "status_code"))

    def test_field_missing_in_one_run_is_not_noise(self):
        records = [rec(1, 200, {"a": 1, "t": "x"})]
        result = noise.analyze(records, [[resp(200, {"a": 1, "t": "y"})], [resp(200, {"a": 1})]])
        self.assertEqual(result["rules"], [])
        self.assertEqual(decisions(result)[(1, "body.t")], ("rejected", "missing_field"))

    def test_type_change_is_not_noise(self):
        records = [rec(1, 200, {"t": "x"})]
        result = noise.analyze(records, [[resp(200, {"t": "y"})], [resp(200, {"t": None})]])
        self.assertEqual(decisions(result)[(1, "body.t")], ("rejected", "type_changed"))

    def test_connection_error_is_not_noise(self):
        records = [rec(1, 200, {"t": "x"})]
        result = noise.analyze(records, [[resp(200, {"t": "y"})],
                                         [Response(0, [], b"", error="ConnectionResetError")]])
        self.assertEqual(result["rules"], [])
        self.assertEqual(decisions(result), {(1, "*"): ("rejected", "connection_error")})

    def test_whole_text_body_is_not_auto_excluded(self):
        records = [rec(1, 200, b"<p>csrf=a</p>", TEXT)]
        result = noise.analyze(records, [[resp(200, b"<p>csrf=b</p>", TEXT)], [resp(200, b"<p>csrf=c</p>", TEXT)]])
        self.assertEqual(result["rules"], [])
        self.assertEqual(decisions(result)[(1, "body")], ("rejected", "whole_body"))

    def test_mixed_request_keeps_only_safe_fields(self):
        records = [rec(1, 200, {"id": 7, "t": "a"})]
        result = noise.analyze(records, [[resp(200, {"id": 8, "t": "b"})], [resp(200, {"id": 8, "t": "c"})]])
        self.assertEqual(result["rules"][0]["fields"], ["body.t"])
        self.assertEqual(decisions(result)[(1, "body.id")], ("rejected", "consistent_difference"))


class DetectAndLoadTest(unittest.TestCase):
    def test_single_run_is_rejected(self):
        with self.assertRaises(ValueError):
            noise.detect([rec(1, 200, {})], "http://127.0.0.1:1", runs=1)

    def test_load_reads_only_rules_and_warns_on_unsafe_manual_rules(self):
        data = {"runs": 2,
                "rules": [{"index": 1, "request": "GET /r1", "fields": ["status", "body"]},
                          {"index": 2, "request": "GET /r2", "fields": ["body.t"]}],
                "candidates": [{"index": 3, "request": "GET /r3", "field": "body.x",
                                "decision": "rejected", "reason": "missing_field"}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "n.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f)
            logs = []
            rules = noise.load(path, log=logs.append)
        self.assertEqual(rules, {1: {"status", "body"}, 2: {"body.t"}})
        self.assertEqual(len(logs), 2)


if __name__ == "__main__":
    unittest.main()
