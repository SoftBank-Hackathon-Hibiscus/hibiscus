"""Docker 없이 끝-대-끝 확인: 기록 → 재생 → 비교, 비밀값 처리."""
import itertools
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from parity import docker_ops
from parity.compare import diff_paths, generalize, view_recorded, view_replayed
from parity.record import load_records, send_request, start_proxy
from parity.redact import REDACTED
from parity.replay import replay

ROOT = Path(__file__).parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LocalApp:
    """../sample-app/app.py 를 임시 데이터 디렉터리로 실행. 매번 새로 띄우면 초기 상태."""

    def __init__(self, workdir, tls=None):
        self.port = free_port()
        self.url = f"{'https' if tls else 'http'}://127.0.0.1:{self.port}"
        self.workdir = workdir
        self.tls = tls           # (cert, key) 또는 None
        self.proc = None

    def start(self, ssl_context=None):
        env = dict(os.environ, PORT=str(self.port),
                   DATA_DIR=os.path.join(self.workdir, "data"),
                   UPLOAD_DIR=tempfile.mkdtemp(prefix="uploads-", dir=self.workdir))
        if self.tls:
            env.update(TLS_CERT=self.tls[0], TLS_KEY=self.tls[1])
        self.proc = subprocess.Popen([sys.executable, str(ROOT.parent / "sample-app" / "app.py")], env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        docker_ops.wait_healthy(self.url + "/healthz", timeout=15, ssl_context=ssl_context)

    def stop(self):
        self.proc.terminate()
        self.proc.wait(10)


def record_simulation(app_url, record_path, ssl_context=None):
    server, recorder = start_proxy("127.0.0.1", 0, app_url, record_path, ssl_context)
    proxy_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        return subprocess.run([sys.executable, str(ROOT / "scripts" / "simulate_usage.py"), "--base", proxy_url],
                              capture_output=True, encoding="utf-8",
                              env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    finally:
        server.shutdown()
        server.server_close()
        recorder.close()


class SecretStub:
    """받은 요청을 서버 쪽에만 보관하고(본문에 되돌려주지 않음), 요청마다 새 세션 쿠키와 토큰을 준다."""

    def __init__(self):
        self.received = []
        counter = itertools.count(1)
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def handle_any(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                stub.received.append({"path": self.path, "headers": dict(self.headers.items()), "body": body})
                n = next(counter)
                data = json.dumps({"name": "alice", "access_token": f"live-token-{n}"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", f"sid=server-secret-{n}; Path=/; HttpOnly")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class SecretSeparationTest(unittest.TestCase):
    """전달용(원본)과 저장용(가린 사본)이 분리되는지, 재생이 새 쿠키를 쓰는지."""

    def setUp(self):
        self.stub = SecretStub()
        self.addCleanup(self.stub.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.record_path = os.path.join(self.tmp.name, "s.jsonl")

        server, recorder = start_proxy("127.0.0.1", 0, self.stub.url, self.record_path)
        proxy = f"http://127.0.0.1:{server.server_address[1]}"
        self.client_responses = [
            send_request(proxy, "POST", "/login?api_key=query-secret",
                         [["Authorization", "Bearer client-secret"], ["Cookie", "sid=old-cookie-secret"],
                          ["Content-Type", "application/json"]],
                         b'{"name":"alice","password":"pw-secret"}'),
            send_request(proxy, "GET", "/me", [["Cookie", "sid=server-secret-1"]], b""),
        ]
        server.shutdown()
        server.server_close()
        recorder.close()

    def test_forwarded_data_is_original(self):
        sent = self.stub.received[0]
        self.assertEqual(sent["path"], "/login?api_key=query-secret")
        self.assertEqual(sent["headers"]["Authorization"], "Bearer client-secret")
        self.assertEqual(sent["headers"]["Cookie"], "sid=old-cookie-secret")
        self.assertIn(b"pw-secret", sent["body"])
        status, _, headers, body = self.client_responses[0]
        self.assertIn(["Set-Cookie", "sid=server-secret-1; Path=/; HttpOnly"], headers)
        self.assertIn(b"live-token-1", body)

    def test_stored_data_has_no_secrets(self):
        text = Path(self.record_path).read_text(encoding="utf-8")
        for secret in ("client-secret", "old-cookie-secret", "query-secret", "pw-secret",
                       "server-secret", "live-token"):
            self.assertNotIn(secret, text)
        first = load_records(self.record_path)[0]
        self.assertEqual(first["request"]["path"], f"/login?api_key={REDACTED}")
        self.assertIn(["Authorization", REDACTED], first["request"]["headers"])
        self.assertIn(["Set-Cookie", f"sid={REDACTED}; Path=/; HttpOnly"], first["response"]["headers"])

    def test_replay_uses_cookies_issued_during_replay(self):
        self.stub.received.clear()
        logs = []
        result = replay(load_records(self.record_path), self.stub.url, log=logs.append)
        first, second = self.stub.received
        self.assertNotIn("Cookie", first["headers"])          # 기록의 (가린) 쿠키는 보내지 않음
        self.assertEqual(second["headers"]["Cookie"], "sid=server-secret-3")  # 재생 중 새로 받은 쿠키
        self.assertNotIn("Authorization", first["headers"])   # 가려진 인증 헤더는 보내지 않음
        self.assertTrue(any("Authorization" in m for m in logs))
        # 기록된 access_token 은 <redacted> → 실제 응답에 값이 있으면 일치
        for rec, resp in zip(load_records(self.record_path), result.responses):
            self.assertEqual(diff_paths(view_recorded(rec["response"]), view_replayed(resp)), [])

    def test_injected_header_replaces_redacted_one(self):
        self.stub.received.clear()
        replay(load_records(self.record_path), self.stub.url, extra_headers=[["Authorization", "Bearer injected"]])
        self.assertEqual(self.stub.received[0]["headers"]["Authorization"], "Bearer injected")


class RecordReplayTest(unittest.TestCase):
    def test_record_then_clean_replay_differs_only_in_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            record_path = os.path.join(tmp, "session.jsonl")
            app = LocalApp(tmp)
            app.start()
            try:
                sim = record_simulation(app.url, record_path)
            finally:
                app.stop()
            self.assertEqual(sim.returncode, 0, sim.stderr)

            records = load_records(record_path)
            self.assertEqual([r["index"] for r in records], list(range(1, 21)))
            png = next(r for r in records if r["request"]["path"] == "/uploads/cat.png"
                       and r["request"]["method"] == "PUT")
            self.assertEqual(png["request"]["body_encoding"], "base64")
            self.assertEqual(records[18]["response"]["status"], 401)   # 로그아웃 후 /me

            # 쿠키 값은 기록 파일에 하나도 남지 않는다
            for r in records:
                for part, key in ((r["request"], "cookie"), (r["response"], "set-cookie")):
                    for name, value in part["headers"]:
                        if name.lower() == key:
                            self.assertRegex(value, rf"^sid=({REDACTED})?(;|$)")

            # 새 프로세스(=초기 상태)에 재생 → created_at 말고는 같아야 한다.
            fresh = LocalApp(tmp)
            fresh.start()
            try:
                result = replay(records, fresh.url)
            finally:
                fresh.stop()
            self.assertIsNone(result.error)
            # 로그인 유지(재생 중 받은 쿠키 사용)와 로그아웃 후 401 이 재현된다
            self.assertEqual([result.responses[i - 1].status for i in (3, 11, 17, 19)], [200, 200, 200, 401])
            diffs = {generalize(p)
                     for rec, resp in zip(records, result.responses)
                     for p in diff_paths(view_recorded(rec["response"]), view_replayed(resp))}
            self.assertEqual(diffs, {"body.created_at", "body[*].created_at"})


if __name__ == "__main__":
    unittest.main()
