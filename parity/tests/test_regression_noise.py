"""회귀 테스트: 기록은 200 인데 재생이 매번 500 이면 test 는 반드시 실패해야 한다.

이전 구현은 '기록과 달랐던 필드'를 전부 노이즈로 저장했다. 그래서 재생 2번이 모두 500 이면
status·본문 필드가 전부 노이즈가 되고, test 에서도 500 이 나오면 모두 무시되어 passed=true 가 됐다.
CLI(noise → test)를 그대로 거쳐 확인한다. Docker 호출만 가짜로 바꾼다.
"""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from parity.__main__ import main
from parity.record import send_request, start_proxy


class SwitchableStub:
    """mode='ok' 이면 200, mode='error' 이면 500 을 돌려주는 서버."""

    def __init__(self):
        self.mode = "ok"
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                if stub.mode == "ok":
                    status, body = 200, {"ok": True, "items": [1, 2]}
                else:
                    status, body = 500, {"error": "boom"}
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def docker_patched():
    return [mock.patch("parity.docker_ops.recreate"),
            mock.patch("parity.docker_ops.wait_healthy", return_value=0.0),
            mock.patch("parity.docker_ops.image_of", return_value="stub:1"),
            mock.patch("parity.facts.collect", return_value=[])]


class ErrorReplayMustFailTest(unittest.TestCase):
    def test_recorded_200_but_every_replay_500_is_not_passed(self):
        stub = SwitchableStub()
        self.addCleanup(stub.close)
        with tempfile.TemporaryDirectory() as tmp:
            record_path = os.path.join(tmp, "session.jsonl")
            result_path = os.path.join(tmp, "result.json")

            server, recorder = start_proxy("127.0.0.1", 0, stub.url, record_path)
            proxy = f"http://127.0.0.1:{server.server_address[1]}"
            for _ in range(2):
                send_request(proxy, "GET", "/items", [], b"")
            server.shutdown()
            server.server_close()
            recorder.close()

            stub.mode = "error"   # 배포 후 서버가 고장난 상황
            patches = docker_patched()
            for p in patches:
                p.start()
                self.addCleanup(p.stop)
            common = ["--record", record_path, "--target", stub.url, "--container", "stub"]
            self.assertEqual(main(["noise", *common]), 0)
            code = main(["test", *common, "--conditions", "none", "--out", result_path])

            with open(result_path, encoding="utf-8") as f:
                result = json.load(f)
            self.assertFalse(result["passed"])
            self.assertEqual(code, 1)
            self.assertEqual(result["replay"], [{"condition": "none", "total": 2, "matched": 0}])
            self.assertEqual([m["actual"] for m in result["mismatches"]],
                             ['500 {"error":"boom"}', '500 {"error":"boom"}'])


if __name__ == "__main__":
    unittest.main()
