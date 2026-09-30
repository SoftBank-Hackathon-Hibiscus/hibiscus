"""샘플 기록이 '개발 PC에서 정상'인 앱의 실제 응답과 같은지 확인한다. Docker 없이 호스트에서 앱을 띄운다."""

import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from premortem.adapters.reference_replay import ReferenceReplayPort

SAMPLES = Path(__file__).resolve().parents[2] / "examples" / "premortem"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LocalApp:
    def __init__(self, scenario, extra_env=None):
        self.port = free_port()
        env = dict(os.environ, PORT=str(self.port), **(extra_env or {}))
        self.process = subprocess.Popen([sys.executable, str(SAMPLES / scenario / "app" / "app.py")], env=env,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=0.5)
                return
            except OSError:
                time.sleep(0.1)
        self.stop()
        raise RuntimeError("샘플 앱이 뜨지 않음")

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=10)


class SampleBaselineTest(unittest.TestCase):
    def check(self, scenario, extra_env=None):
        app = LocalApp(scenario, extra_env)
        try:
            base = SAMPLES / scenario / "baseline"
            outcome = ReferenceReplayPort().replay(base / "session.jsonl", base / "noise.json",
                                                   lambda i: f"http://127.0.0.1:{app.port}", lambda i: None, {})
        finally:
            app.stop()
        self.assertEqual(outcome.matched_count, outcome.expected_count,
                         [r.summary for r in outcome.results if not r.matched])

    def test_state_loss_baseline_matches_local_app(self):
        with tempfile.TemporaryDirectory() as data_dir:
            self.check("state-loss", {"DATA_DIR": data_dir})

    def test_binding_baseline_matches_local_app(self):
        # 개발 PC에서는 127.0.0.1로 접속하므로 정상이다.
        self.check("binding")


if __name__ == "__main__":
    unittest.main()
