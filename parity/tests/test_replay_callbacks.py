"""실제 HTTP 주소 변경과 외부 훅 실패를 검사한다 (Docker 조작 없음)."""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from parity.record import make_ssl_context
from parity.replay import HookAbort, ReplayHook, replay
from parity.report import build_result, evaluate
from tests.test_https_verify import OPENSSL, make_cert
from tests.test_record_replay import LocalApp


def records(count=3):
    return [{"index": i,
             "request": {"method": "GET", "path": "/posts", "headers": [],
                         "body": "", "body_encoding": "utf8"},
             "response": {"status": 200, "headers": [["Content-Type", "application/json"]],
                          "body": "[]", "body_encoding": "utf8"}}
            for i in range(1, count + 1)]


class Endpoint:
    def __init__(self):
        self.received = []
        received = self.received

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append({"path": self.path, "cookie": self.headers.get("Cookie")})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", "sid=replayed-session; Path=/")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"[]")

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class ReplayCallbacksTest(unittest.TestCase):
    def endpoint(self):
        endpoint = Endpoint()
        self.addCleanup(endpoint.close)
        return endpoint

    def test_next_request_uses_new_address_after_comparison(self):
        first, second = self.endpoint(), self.endpoint()
        target = [first.url]
        trace, observed = [], []

        def resolve(index):
            trace.append(("target", index))
            return target[0]

        def observe(index, record, response):
            self.assertEqual(response.status, 200)
            observed.append(index)
            trace.append(("observed", index))

        def between(index):
            self.assertEqual(observed[-1], index)
            trace.append(("between", index))
            target[0] = second.url

        source = records()
        snapshot = json.dumps(source)
        result = replay(source, first.url, target_for_request=resolve,
                        on_response=observe, after_response=between)
        self.assertIsNone(result.error)
        self.assertEqual(trace, [("target", 1), ("observed", 1), ("between", 1),
                                 ("target", 2), ("observed", 2), ("between", 2),
                                 ("target", 3), ("observed", 3)])
        self.assertEqual(len(first.received), 1)
        self.assertEqual(len(second.received), 2)
        self.assertEqual(second.received[0]["cookie"], "sid=replayed-session")
        self.assertEqual(json.dumps(source), snapshot)

    def test_lifecycle_error_preserves_last_response_and_unissued_requests(self):
        endpoint = self.endpoint()
        failure = RuntimeError("replacement unavailable")

        def fail(index):
            raise failure

        source = records()
        result = replay(source, endpoint.url, after_response=fail)
        self.assertIs(result.cause, failure)
        self.assertEqual(result.responses[0].status, 200)
        self.assertEqual(result.responses[1:], [None, None])
        entry, differences = evaluate("replace", source, result, {}, [])
        self.assertEqual((entry["total"], entry["matched"]), (3, 1))
        self.assertFalse(build_result("demo", [], [entry], differences, "unknown")["passed"])

    def test_target_failure_does_not_send_following_requests(self):
        endpoint = self.endpoint()

        def resolve(index):
            if index == 2:
                raise HookAbort("no replacement address")
            return endpoint.url

        result = replay(records(), endpoint.url, target_for_request=resolve)
        self.assertEqual(len(endpoint.received), 1)
        self.assertEqual(result.responses[1:], [None, None])
        self.assertIsInstance(result.cause, HookAbort)

    def test_observer_failure_prevents_environment_change(self):
        endpoint = self.endpoint()
        changed = []

        def fail(*args):
            raise ValueError("comparison failed")

        result = replay(records(), endpoint.url, on_response=fail, after_response=changed.append)
        self.assertIsNotNone(result.error)
        self.assertEqual(changed, [])
        self.assertIsNotNone(result.responses[0])
        self.assertEqual(len(endpoint.received), 1)

    def test_invalid_dynamic_urls_fail_before_network_and_hide_embedded_secret(self):
        endpoint = self.endpoint()
        for bad in (None, "", "file:///tmp/app", "http://", "http://host:0", "http://host:bad",
                    "http://user:DO_NOT_LOG@localhost", endpoint.url + "?token=DO_NOT_LOG",
                    endpoint.url + "#fragment", endpoint.url + "\n"):
            with self.subTest(target=bad):
                result = replay(records(1), endpoint.url, target_for_request=lambda i: bad)
                self.assertIsNotNone(result.error)
                self.assertNotIn("DO_NOT_LOG", result.error)
                self.assertEqual(result.responses, [None])
        self.assertEqual(endpoint.received, [])

    def test_empty_input_is_not_success(self):
        result = replay([], "http://localhost:1")
        self.assertIsNotNone(result.error)

    def test_legacy_hooks_still_run_in_order_including_final_request(self):
        endpoint = self.endpoint()
        trace = []

        class Hook(ReplayHook):
            def before_run(self, indices):
                trace.append(("start", indices))

            def before_request(self, index):
                trace.append(("before", index))

            def after_request(self, index):
                trace.append(("after", index))

        result = replay(records(2), endpoint.url, hooks=[Hook()])
        self.assertIsNone(result.error)
        self.assertEqual(trace, [("start", [1, 2]), ("before", 1), ("after", 1),
                                 ("before", 2), ("after", 2)])

    @unittest.skipUnless(OPENSSL, "openssl required for TLS fixture")
    def test_dynamic_https_keeps_certificate_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = make_cert(tmp)
            context = make_ssl_context("https://127.0.0.1", cert)
            app = LocalApp(tmp, tls=(cert, key))
            app.start(context)
            try:
                untrusted = replay(records(1), "http://unused", target_for_request=lambda i: app.url)
                self.assertEqual(untrusted.responses[0].status, 0)
                self.assertIn("CERTIFICATE_VERIFY_FAILED", untrusted.responses[0].error)
                trusted = replay(records(1), "http://unused", target_for_request=lambda i: app.url,
                                 ssl_context=context)
                self.assertEqual(trusted.responses[0].status, 200)
            finally:
                app.stop()


if __name__ == "__main__":
    unittest.main()
