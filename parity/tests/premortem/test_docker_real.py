"""실제 Docker 시험. PREMORTEM_DOCKER_TESTS=1일 때만 실행한다 (ACCEPTANCE B05, B06, B09, C13).

python -m premortem self-test --docker 로 켤 수 있다.
"""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from premortem.config import Settings
from premortem.demo import run_demo
from premortem.jsonio import load_json, load_jsonl

ENABLED = os.environ.get("PREMORTEM_DOCKER_TESTS") == "1"


def leftover(run_id):
    result = subprocess.run(["docker", "ps", "-a", "-q", "--filter", f"label=premortem.run_id={run_id}"],
                            capture_output=True, text=True, timeout=30)
    return result.stdout.strip()


@unittest.skipUnless(ENABLED, "PREMORTEM_DOCKER_TESTS=1일 때만 실제 Docker 시험")
class RealDockerTest(unittest.TestCase):
    def test_b09_state_loss_restart_keeps_replace_loses(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_demo("state-loss", "off", Settings(), run_root=Path(tmp))
            run_dir = Path(result["pretest"]["run_dir"])
            report = load_json(run_dir / "env_report.json")
            evidence = {r["evidence_id"]: r for r in load_jsonl(run_dir / "evidence.jsonl")}
        self.assertEqual(result["pretest"]["conditions"], {"none": "passed", "restart": "passed", "replace": "failed"})
        replace = [c for c in report["conditions"] if c["name"] == "replace"][0]
        self.assertEqual([m["request_index"] for m in replace["mismatches"]], [4, 5])
        self.assertIn("같은 컨테이너", evidence["restart-lifecycle-3"]["sanitized_summary"])
        self.assertIn("새 컨테이너", evidence["replace-lifecycle-3"]["sanitized_summary"])
        self.assertEqual((report["execution_mode"], report["replay_backend"], report["team_parity_integrated"]),
                         ("real", "reference", False))
        self.assertFalse(report["gate"]["handoff_ready"])
        self.assertEqual(leftover(report["run_id"]), "")

    def test_binding_pretest_detects_loopback_bind(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_demo("binding", "off", Settings(), run_root=Path(tmp))
            report = load_json(Path(result["pretest"]["run_dir"]) / "env_report.json")
        self.assertEqual(result["pretest"]["conditions"], {"none": "failed", "restart": "skipped", "replace": "skipped"})
        self.assertIn("binding 후보", report["conditions"][0]["reason"])
        self.assertEqual(leftover(report["run_id"]), "")

    def test_e01_e05_binding_fix_retested_with_same_baseline(self):
        app = Path(__file__).resolve().parents[2] / "examples/premortem/binding/app/app.py"
        original = app.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            result = run_demo("binding", "fixture", Settings(), run_root=Path(tmp))
            repair = result["repair"]
            pre_dir, retest_dir = Path(result["pretest"]["run_dir"]), Path(repair["retest"]["run_dir"])
            pre, retest = load_json(pre_dir / "env_report.json"), load_json(retest_dir / "env_report.json")
            review = (retest_dir / "review.md").read_text(encoding="utf-8")
        self.assertEqual(pre["overall_status"], "failed")  # 결함 앱의 결과는 그대로 failed로 남는다
        self.assertEqual(repair["retest"]["conditions"], {"none": "passed", "restart": "passed", "replace": "passed"})
        self.assertEqual(repair["review_status"], "awaiting_human_review")
        self.assertEqual(retest["parent_run_id"], pre["run_id"])
        self.assertEqual(retest["baseline"], pre["baseline"])
        self.assertNotEqual(retest["image"]["local_image_id"], pre["image"]["local_image_id"])
        self.assertNotEqual(retest["source"]["tree_sha256"], pre["source"]["tree_sha256"])
        self.assertIn("합성 예시 응답", review)
        self.assertEqual(app.read_bytes(), original)  # 원본 앱은 바뀌지 않는다
        self.assertEqual(leftover(pre["run_id"]) + leftover(retest["run_id"]), "")

    def test_g02_recorded_answer_is_revalidated_on_a_new_run(self):
        # 테스트용으로 live 기록 모양을 합성한다. 실제 호출 결과가 아니다.
        fixture = load_json(Path(__file__).resolve().parents[2] / "examples/premortem/fixtures/binding-analysis.fixture.json")
        with tempfile.TemporaryDirectory() as tmp:
            recording = Path(tmp) / "synthetic-live.analysis.json"
            recording.write_text(json.dumps({"schema_version": "1.0", "run_id": "binding-pre-earlier",
                                             "provider": "anthropic_messages", "model": "synthetic-model",
                                             "status": "succeeded", "created_at": "2026-10-01T00:00:00Z",
                                             "output": fixture["output"]}, ensure_ascii=False), encoding="utf-8")
            result = run_demo("binding", "recorded", Settings(), analysis_file=recording, run_root=Path(tmp) / "runs")
        self.assertEqual(result["repair"]["analysis"]["provider"], "recorded_live")
        self.assertEqual(result["repair"]["retest"]["overall_status"], "passed")
        self.assertIn("이번 실행에서 AI 호출 없음", result["repair"]["summary"][0])


if __name__ == "__main__":
    unittest.main()
