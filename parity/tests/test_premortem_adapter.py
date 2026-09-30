"""선택적 어댑터 계약 검사. premortem 설치·Docker·AI 없이 실제 parity 재생기를 사용한다."""
import importlib
import json
import sys
import tempfile
import types
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

from parity.premortem_adapter import ParityReplayPort
from parity.replay import Response


class PortError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


@dataclass
class RequestResult:
    request_index: int
    matched: bool
    kind: object
    summary: str


@dataclass
class ReplayOutcome:
    backend: str
    expected_count: int
    executed_count: int
    matched_count: int
    results: list = field(default_factory=list)
    facts: object = None


class HookError(PortError):
    def __init__(self, cause, partial):
        super().__init__(cause.code, cause.message)
        self.cause, self.partial = cause, partial


def protocol_modules():
    package = types.ModuleType("premortem")
    package.__path__ = []
    errors = types.ModuleType("premortem.errors")
    errors.PremortemError = PortError
    protocol = types.ModuleType("premortem.replay_port")
    protocol.ReplayOutcome = ReplayOutcome
    protocol.RequestResult = RequestResult
    protocol.ReplayHookError = HookError
    return {"premortem": package, "premortem.errors": errors, "premortem.replay_port": protocol}


def recorded(index, body=None):
    return {
        "index": index,
        "request": {"method": "GET", "path": "/posts", "headers": [], "body": "", "body_encoding": "utf8"},
        "response": {"status": 200, "headers": [["Content-Type", "application/json"]],
                     "body": json.dumps({"ok": True} if body is None else body), "body_encoding": "utf8"},
    }


def response(body=None, status=200):
    return Response(status, [["Content-Type", "application/json"]],
                    json.dumps({"ok": True} if body is None else body).encode())


class PremortemAdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.session = Path(self.tmp.name) / "session.jsonl"
        self.noise = Path(self.tmp.name) / "noise.json"
        self.write_records([recorded(1), recorded(2), recorded(3)])
        self.write_noise({"rules": [], "candidates": [], "runs": 2})
        self.protocol = patch.dict(sys.modules, protocol_modules())
        self.protocol.start()
        self.addCleanup(self.protocol.stop)
        self.adapter = ParityReplayPort()

    def write_records(self, records):
        self.session.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")

    def write_noise(self, noise):
        self.noise.write_text(json.dumps(noise), encoding="utf-8")

    def run_port(self, target=None, after=None, secrets=None):
        return self.adapter.replay(self.session, self.noise,
                                   target or (lambda index: "http://127.0.0.1:8080"),
                                   after or (lambda index: None), {} if secrets is None else secrets)

    def test_lazy_dependency_and_clear_missing_dependency(self):
        with patch.dict(sys.modules, {"premortem": None, "premortem.errors": None, "premortem.replay_port": None}):
            module = importlib.import_module("parity.premortem_adapter")
            adapter = module.ParityReplayPort()
            with self.assertRaisesRegex(RuntimeError, "premortem ReplayPort"):
                adapter.replay(self.session, self.noise, lambda i: "http://localhost", lambda i: None, {})

    def test_target_updates_after_compared_response_only_between_requests(self):
        events, state = [], {"port": 8080}

        def send(record, target, *args):
            events.append(("send", record["index"], target))
            return response()

        def after(index):
            events.append(("after", index))
            state["port"] += 1

        with patch("parity.replay._send", side_effect=send):
            outcome = self.run_port(lambda i: f"http://127.0.0.1:{state['port']}", after)
        self.assertEqual(events, [("send", 1, "http://127.0.0.1:8080"), ("after", 1),
                                  ("send", 2, "http://127.0.0.1:8081"), ("after", 2),
                                  ("send", 3, "http://127.0.0.1:8082")])
        self.assertEqual((outcome.backend, outcome.expected_count, outcome.executed_count, outcome.matched_count),
                         ("parity", 3, 3, 3))
        self.assertIsNone(outcome.facts)

    def test_lifecycle_error_preserves_compared_result_and_sanitizes_message(self):
        def fail(index):
            raise PortError("REPLACE_FAILED", "token=secret-value http://private.test")

        with patch("parity.replay._send", return_value=response()) as send:
            with self.assertRaises(HookError) as caught:
                self.run_port(after=fail)
        error = caught.exception
        self.assertEqual(error.code, "REPLACE_FAILED")
        self.assertEqual((error.partial.expected_count, error.partial.executed_count, error.partial.matched_count), (3, 1, 1))
        self.assertEqual(error.partial.results[0].request_index, 1)
        self.assertEqual(send.call_count, 1)
        self.assertNotIn("secret-value", str(error))
        self.assertNotIn("private.test", str(error.cause))

    def test_target_error_keeps_prior_comparison(self):
        def target(index):
            if index == 2:
                raise ValueError("private-target-secret")
            return "http://127.0.0.1:8080"

        with patch("parity.replay._send", return_value=response()):
            with self.assertRaises(HookError) as caught:
                self.run_port(target=target)
        self.assertEqual(caught.exception.partial.executed_count, 1)
        self.assertNotIn("private-target-secret", str(caught.exception))

    def test_transport_failure_is_counted_and_aborts_without_lifecycle_callback(self):
        hooks = []
        with patch("parity.replay._send", return_value=Response(0, [], b"", error="secret-url")) as send:
            with self.assertRaises(HookError) as caught:
                self.run_port(after=hooks.append)
        partial = caught.exception.partial
        self.assertEqual((partial.executed_count, partial.matched_count), (1, 0))
        self.assertEqual(partial.results[0].kind, "transport")
        self.assertEqual(hooks, [])
        self.assertEqual(send.call_count, 1)
        self.assertNotIn("secret-url", str(caught.exception) + str(partial))

    def test_noise_cannot_hide_status_missing_field_or_type_change(self):
        self.write_records([recorded(1, {"value": "before"})])
        self.write_noise({"rules": [{"index": 1, "fields": ["status", "body.value"]}], "candidates": []})
        for actual, kind in ((response({"value": "after"}, 500), "status"),
                             (response({}), "body"), (response({"value": None}), "body")):
            with self.subTest(kind=kind, actual=actual):
                with patch("parity.replay._send", return_value=actual):
                    outcome = self.run_port()
                self.assertEqual(outcome.matched_count, 0)
                self.assertEqual(outcome.results[0].kind, kind)

    def test_noise_uses_existing_comparison_and_summaries_do_not_export_bodies(self):
        self.write_records([recorded(1, {"time": "original", "value": "expected-secret"})])
        self.write_noise({"rules": [{"index": 1, "fields": ["body.time"]}], "candidates": []})
        with patch("parity.replay._send", return_value=response({"time": "different", "value": "actual-secret"})):
            outcome = self.run_port()
        self.assertEqual(outcome.matched_count, 0)
        self.assertIn("1개 필드", outcome.results[0].summary)
        self.assertNotIn("secret", outcome.results[0].summary)
        with patch("parity.replay._send", return_value=response({"time": "different", "value": "expected-secret"})):
            self.assertEqual(self.run_port().matched_count, 1)

    def test_whole_text_body_noise_cannot_hide_completely_different_response(self):
        record = recorded(1)
        record["response"].update(headers=[["Content-Type", "text/plain"]], body="all good")
        self.write_records([record])
        actual = Response(200, [["Content-Type", "text/plain"]], b"completely broken")
        self.write_noise({"rules": [{"index": 1, "fields": ["body"]}], "candidates": []})
        with patch("parity.replay._send", return_value=actual) as send:
            with self.assertRaises(PortError) as caught:
                self.run_port()
            send.assert_not_called()
        self.assertEqual(caught.exception.code, "INPUT_INVALID")
        self.assertIn("body", str(caught.exception))
        self.write_noise({"rules": [], "candidates": []})
        with patch("parity.replay._send", return_value=actual):
            outcome = self.run_port()
        self.assertEqual(outcome.matched_count, 0)
        self.assertEqual(outcome.results[0].kind, "body")

    def test_invalid_records_rejected_before_network(self):
        bad_rows = [[], [recorded(0)], [recorded(True)], [recorded(2)],
                    [recorded(1), recorded(1)], [recorded(2), recorded(1)],
                    [{"request_index": 1, "method": "GET", "path": "/", "expected": {"status": 200}}]]
        for rows in bad_rows:
            with self.subTest(rows=rows):
                self.write_records(rows)
                with patch("parity.replay._send") as send:
                    with self.assertRaises(PortError):
                        self.run_port()
                    send.assert_not_called()

    def test_wrong_or_missing_noise_is_not_silently_ignored(self):
        for noise in ({}, {"ignored_json_pointers": []}, {"rules": "wrong"},
                      {"rules": [{"index": 4, "fields": []}]}, {"rules": [], "candidates": {}},
                      {"rules": [{"index": True, "fields": []}]}):
            with self.subTest(noise=noise):
                self.write_noise(noise)
                with patch("parity.replay._send") as send:
                    with self.assertRaises(PortError):
                        self.run_port()
                    send.assert_not_called()
        self.noise.unlink()
        with self.assertRaises(PortError):
            self.run_port()

    def test_runtime_secrets_are_not_inferred_or_exported(self):
        with patch("parity.replay._send") as send:
            with self.assertRaises(PortError) as caught:
                self.run_port(secrets={"Authorization": "Bearer secret-value"})
            send.assert_not_called()
        self.assertEqual(caught.exception.code, "MISSING_REPLAY_SECRET")
        self.assertNotIn("secret-value", str(caught.exception))

    def test_baseline_change_invalidates_even_all_matched(self):
        def mutate(index):
            self.write_noise({"rules": [], "candidates": [], "changed": True})

        with patch("parity.replay._send", return_value=response()):
            with self.assertRaises(HookError) as caught:
                self.run_port(after=mutate)
        self.assertEqual(caught.exception.code, "BASELINE_CHANGED")
        self.assertEqual(caught.exception.partial.matched_count, 3)

    def test_success_keeps_baseline_files_unchanged(self):
        before = self.session.read_bytes(), self.noise.read_bytes()
        with patch("parity.replay._send", return_value=response()):
            self.run_port()
        self.assertEqual(before, (self.session.read_bytes(), self.noise.read_bytes()))


if __name__ == "__main__":
    unittest.main()
