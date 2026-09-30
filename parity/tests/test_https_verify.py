"""verify 모드: Docker 조작 없이 https 대상에 요청만 재생해 확인한다.

guestbook 앱을 자체 서명 인증서로 HTTPS 로 띄우고, 기록 → 노이즈 탐지 → verify CLI 를 모두 https 로 거친다.
openssl 이 없으면 인증서를 만들 수 없으므로 건너뛴다.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from parity.__main__ import main
from parity.noise import default_noise_path, detect, save
from parity.record import load_records, make_ssl_context
from tests.test_record_replay import LocalApp, record_simulation

OPENSSL = shutil.which("openssl")
MOCK_KEYS = list(json.loads((Path(__file__).parent.parent / "mocks" / "test_result.json")
                            .read_text(encoding="utf-8")))


def make_cert(directory):
    cert, key = os.path.join(directory, "cert.pem"), os.path.join(directory, "key.pem")
    subprocess.run([OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                    "-days", "1", "-subj", "/CN=parity-test",
                    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
                   check=True, capture_output=True)
    return cert, key


@unittest.skipUnless(OPENSSL, "openssl 이 없어 테스트용 인증서를 만들 수 없음")
class HttpsVerifyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = cls._tmp.name
        cls.cert, cls.key = make_cert(cls.tmp)
        cls.ctx = make_ssl_context("https://127.0.0.1", cls.cert)
        cls.record = os.path.join(cls.tmp, "session.jsonl")

        app = LocalApp(cls.tmp, tls=(cls.cert, cls.key))
        app.start(cls.ctx)
        try:
            sim = record_simulation(app.url, cls.record, cls.ctx)   # 프록시 → https 대상
            assert sim.returncode == 0, sim.stderr

            def restart_fresh():
                app.stop()
                app.start(cls.ctx)
            noise = detect(load_records(cls.record), app.url, runs=2, prepare=restart_fresh,
                           log=lambda m: None, ssl_context=cls.ctx)
            save(noise, default_noise_path(cls.record))
        finally:
            app.stop()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def fresh_app(self):
        app = LocalApp(self.tmp, tls=(self.cert, self.key))
        app.start(self.ctx)
        self.addCleanup(app.stop)
        return app

    def run_verify(self, *extra, record=None):
        out = os.path.join(self.tmp, f"verify-{self.id().rsplit('.', 1)[-1]}.json")
        code = main(["verify", "--record", record or self.record, "--out", out, *extra])
        result = None
        if os.path.exists(out):
            with open(out, encoding="utf-8") as f:
                result = json.load(f)
        return code, result

    def test_https_verify_passes_with_trusted_ca(self):
        app = self.fresh_app()
        code, result = self.run_verify("--target", app.url, "--cafile", self.cert, "--allow-writes")
        self.assertEqual(code, 0)
        self.assertEqual(list(result), MOCK_KEYS)                  # 결과 형식은 test 와 같다
        self.assertEqual(result["stage"], "verify")
        self.assertEqual((result["commit"], result["image"], result["facts"]), ("unknown", "unknown", []))
        self.assertEqual(result["replay"], [{"condition": "none", "total": 20, "matched": 20}])
        self.assertTrue(result["passed"])

    def test_untrusted_certificate_fails(self):
        app = self.fresh_app()
        code, result = self.run_verify("--target", app.url, "--allow-writes")   # --cafile 없음
        self.assertEqual(code, 1)
        self.assertFalse(result["passed"])
        self.assertEqual(result["replay"][0]["matched"], 0)
        self.assertIn("CERTIFICATE_VERIFY_FAILED", result["mismatches"][0]["actual"])

    def test_writes_are_refused_without_flag(self):
        app = self.fresh_app()
        code, result = self.run_verify("--target", app.url, "--cafile", self.cert)
        self.assertEqual(code, 2)
        self.assertIsNone(result)

    def test_read_only_record_needs_no_flag(self):
        app = self.fresh_app()
        read_only = os.path.join(self.tmp, "readonly.jsonl")
        first = load_records(self.record)[0]                       # GET /posts → []
        self.assertEqual(first["request"]["method"], "GET")
        Path(read_only).write_text(json.dumps(first, ensure_ascii=False) + "\n", encoding="utf-8")
        code, result = self.run_verify("--target", app.url, "--cafile", self.cert, record=read_only)
        self.assertEqual(code, 0)
        self.assertTrue(result["passed"])


if __name__ == "__main__":
    unittest.main()
