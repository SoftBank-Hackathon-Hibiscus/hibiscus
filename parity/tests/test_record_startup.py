"""기록 시작 실패는 기존 파일을 보존하고 소켓과 대기 스레드를 정리한다."""
import json
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from parity import record as recording


class RecordStartupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / "session.jsonl"
        self.original = b"previous recording must survive startup failure\n"
        self.output.write_bytes(self.original)

    def capture_servers(self):
        servers = []
        original = recording.ThreadingHTTPServer

        def create(*args, **kwargs):
            server = original(*args, **kwargs)
            servers.append(server)
            self.addCleanup(server.server_close)
            return server

        return servers, create

    def assert_released(self, servers):
        self.assertEqual(len(servers), 1)
        server = servers[0]
        self.assertEqual(server.socket.fileno(), -1)
        with socket.socket() as probe:
            probe.bind(server.server_address)

    def test_busy_port_preserves_existing_recording(self):
        with socket.socket() as occupied:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            with self.assertRaises(OSError):
                server, recorder = recording.start_proxy("127.0.0.1", occupied.getsockname()[1],
                                                         "http://127.0.0.1:1", self.output)
                try:
                    server.shutdown()
                finally:
                    server.server_close()
                    recorder.close()
        self.assertEqual(self.output.read_bytes(), self.original,
                         "existing recording changed before the proxy could start")

    def test_thread_start_failure_preserves_file_and_releases_socket(self):
        servers, create = self.capture_servers()
        with patch.object(recording, "ThreadingHTTPServer", side_effect=create), \
                patch.object(recording.threading.Thread, "start",
                             side_effect=RuntimeError("thread unavailable")):
            with self.assertRaisesRegex(RuntimeError, "thread unavailable"):
                recording.start_proxy("127.0.0.1", 0, "http://127.0.0.1:1", self.output)
        self.assertEqual(self.output.read_bytes(), self.original)
        self.assert_released(servers)

    def test_open_failure_releases_socket_and_waiting_worker(self):
        servers, create = self.capture_servers()
        workers = []
        original_thread = threading.Thread

        def thread(*args, **kwargs):
            worker = original_thread(*args, **kwargs)
            workers.append(worker)
            return worker

        with patch.object(recording, "ThreadingHTTPServer", side_effect=create), \
                patch.object(recording.threading, "Thread", side_effect=thread), \
                patch.object(recording, "open", create=True,
                             side_effect=PermissionError("recording unavailable")):
            with self.assertRaisesRegex(PermissionError, "recording unavailable"):
                recording.start_proxy("127.0.0.1", 0, "http://127.0.0.1:1", self.output)
        self.assertEqual(self.output.read_bytes(), self.original)
        self.assert_released(servers)
        self.assertEqual(len(workers), 1)
        workers[0].join(timeout=1)
        self.assertFalse(workers[0].is_alive())

    def test_success_records_real_http_and_flushes_before_close(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                payload = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        upstream_worker = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_worker.start()

        def stop_upstream():
            upstream.shutdown()
            upstream.server_close()
            upstream_worker.join(timeout=1)

        self.addCleanup(stop_upstream)
        target = "http://127.0.0.1:" + str(upstream.server_address[1])
        server, recorder = recording.start_proxy("127.0.0.1", 0, target, self.output)

        def stop_proxy():
            server.shutdown()
            server.server_close()
            recorder.close()

        self.addCleanup(stop_proxy)
        proxy = "http://127.0.0.1:" + str(server.server_address[1])
        status, _, _, body = recording.send_request(proxy, "GET", "/healthz", [], b"", timeout=2)
        self.assertEqual((status, body), (200, b'{"ok":true}'))
        stored = [json.loads(line) for line in self.output.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["index"], 1)
        self.assertEqual(stored[0]["request"]["path"], "/healthz")
        self.assertEqual(stored[0]["response"]["status"], 200)
        self.assertEqual(recorder.count, 1)


if __name__ == "__main__":
    unittest.main()
