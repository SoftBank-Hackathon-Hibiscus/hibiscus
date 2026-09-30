"""샘플 전용 reference 재생기 (ACCEPTANCE B01, C06, C07, C13 일부)."""

import json
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from premortem.adapters.reference_replay import ReferenceReplayPort, check_local_target
from premortem.errors import PremortemError
from premortem.replay_port import ReplayHookError

SAMPLES = Path(__file__).resolve().parents[2] / "examples" / "premortem"


class ScriptedServer:
    """요청 순서대로 정해 둔 응답을 돌려주는 로컬 서버. 받은 요청을 순서대로 기록한다."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.seen = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _reply(self):
                outer.seen.append(("request", self.command, self.path))
                status, body = outer.responses.pop(0)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _reply

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class ReferenceReplayTest(unittest.TestCase):
    session = SAMPLES / "state-loss" / "baseline" / "session.jsonl"
    noise = SAMPLES / "state-loss" / "baseline" / "noise.json"
    good = [(200, {"ready": True}), (201, {"id": 1, "text": "hello"}), (200, [{"id": 1, "text": "hello"}]),
            (200, {"id": 1, "text": "hello"}), (200, [{"id": 1, "text": "hello"}]), (200, {"ready": True})]

    def test_all_match(self):
        with ScriptedServer(self.good) as server:
            outcome = ReferenceReplayPort().replay(self.session, self.noise, lambda i: server.url, lambda i: None, {})
        self.assertEqual((outcome.expected_count, outcome.executed_count, outcome.matched_count), (6, 6, 6))
        self.assertEqual(outcome.backend, "reference")

    def test_b01_hook_runs_after_response_and_before_next_request(self):
        with ScriptedServer(self.good) as server:
            def hook(index):
                server.seen.append(("hook", index))
            ReferenceReplayPort().replay(self.session, self.noise, lambda i: server.url, hook, {})
        order = server.seen
        position = order.index(("hook", 3))
        self.assertEqual([e for e in order[:position] if e[0] == "request"].__len__(), 3)
        self.assertEqual(order[position + 1][0], "request")
        self.assertEqual(sum(1 for e in order if e[0] == "hook"), 5)  # 마지막 요청 뒤에는 부르지 않음

    def test_c06_status_error_is_mismatch_not_noise(self):
        responses = list(self.good)
        responses[3] = (500, {"error": "boom"})
        with ScriptedServer(responses) as server:
            outcome = ReferenceReplayPort().replay(self.session, self.noise, lambda i: server.url, lambda i: None, {})
        failed = [r for r in outcome.results if not r.matched]
        self.assertEqual([(r.request_index, r.kind) for r in failed], [(4, "status")])
        self.assertEqual(outcome.matched_count, 5)

    def test_c07_missing_field_and_type_change_are_mismatches(self):
        responses = list(self.good)
        responses[1] = (201, {"id": "1", "text": "hello"})
        responses[3] = (200, {"id": 1})
        with ScriptedServer(responses) as server:
            outcome = ReferenceReplayPort().replay(self.session, self.noise, lambda i: server.url, lambda i: None, {})
        self.assertEqual([r.request_index for r in outcome.results if not r.matched], [2, 4])

    def test_c07_transport_failure_is_mismatch(self):
        with ScriptedServer(self.good) as server:
            url = server.url
        outcome = ReferenceReplayPort(request_timeout=1).replay(self.session, self.noise, lambda i: url, lambda i: None, {})
        self.assertEqual(outcome.matched_count, 0)
        self.assertTrue(all(r.kind == "transport" for r in outcome.results))

    def test_hook_exception_is_not_swallowed(self):
        def hook(index):
            if index == 3:
                raise PremortemError("DOCKER_COMMAND_FAILED", "restart 실패")
        with ScriptedServer(self.good) as server, self.assertRaises(ReplayHookError) as caught:
            ReferenceReplayPort().replay(self.session, self.noise, lambda i: server.url, hook, {})
        self.assertEqual(caught.exception.code, "DOCKER_COMMAND_FAILED")
        self.assertEqual(caught.exception.partial.executed_count, 3)

    def test_c13_real_project_session_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            copied = Path(tmp) / "session.jsonl"
            shutil.copyfile(self.session, copied)
            with self.assertRaises(PremortemError) as caught:
                ReferenceReplayPort().replay(copied, self.noise, lambda i: "http://127.0.0.1:1", lambda i: None, {})
        self.assertEqual(caught.exception.code, "PARITY_ADAPTER_MISSING")

    def test_only_loopback_targets(self):
        for bad in ("http://example.com:80", "https://127.0.0.1:443", "http://169.254.169.254:80", "http://127.0.0.1"):
            with self.subTest(bad=bad), self.assertRaises(PremortemError):
                check_local_target(bad)
        check_local_target("http://127.0.0.1:8080")


if __name__ == "__main__":
    unittest.main()
