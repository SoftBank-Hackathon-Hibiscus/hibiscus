"""CLI 실행 경계: 실제 Docker/Git/HTTP 없이 실패 결과와 기준 보존을 확인한다."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from parity import execution
from parity.__main__ import main
from parity.replay import ReplayResult, Response


IMAGE_ID = "sha256:" + "a" * 64
OTHER_IMAGE_ID = "sha256:" + "b" * 64
JSON_HEADERS = [["Content-Type", "application/json"]]
RESULT_KEYS = ["stage", "commit", "image", "passed", "facts", "replay", "mismatches"]
FACTS = [{"kind": "sqlite", "path": "/app/data/data.db",
          "storage": "container_layer", "evidence": "SQLite format 3"}]


def recorded(index, path, body):
    return {
        "index": index,
        "request": {"method": "GET", "path": path, "headers": [],
                    "body": "", "body_encoding": "utf8"},
        "response": {"status": 200, "headers": JSON_HEADERS,
                     "body": json.dumps(body), "body_encoding": "utf8"},
    }


def response(body, status=200):
    return Response(status, copy.deepcopy(JSON_HEADERS), json.dumps(body).encode("utf-8"))


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.record_path = self.directory / "session.jsonl"
        self.noise_path = self.directory / "session.noise.json"
        self.out = self.directory / "result.json"
        self.diagnostics_path = self.directory / "result.diagnostics.json"
        self.records = [recorded(1, "/posts", [{"id": 1}]),
                        recorded(2, "/me", {"name": "alice"})]
        self.responses = [response([{"id": 1}]), response({"name": "alice"})]
        self.write_records(self.records)
        self.write_noise({"rules": [], "candidates": []})

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.commit = stack.enter_context(patch("parity.execution.git_commit",
                                                return_value=("abc1234", "mocked")))
        self.image_name = stack.enter_context(patch.object(execution.docker_ops, "image_of",
                                                           return_value="guestbook:1"))
        self.image_id = stack.enter_context(patch.object(execution.docker_ops, "image_id_of",
                                                         return_value=IMAGE_ID))
        self.recreate = stack.enter_context(patch.object(execution.docker_ops, "recreate"))
        self.health = stack.enter_context(patch.object(execution.docker_ops, "wait_healthy",
                                                       return_value=0.0))
        self.collect = stack.enter_context(patch.object(execution.facts_mod, "collect",
                                                        return_value=copy.deepcopy(FACTS)))
        self.replay = stack.enter_context(patch("parity.execution.replay",
                                                return_value=ReplayResult(self.responses)))

    def write_records(self, records):
        self.record_path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")

    def write_noise(self, value):
        self.noise_path.write_text(json.dumps(value), encoding="utf-8")

    def run_cli(self, conditions="none", extra=(), out=None):
        arguments = ["test", "--record", str(self.record_path), "--noise", str(self.noise_path),
                     "--target", "http://127.0.0.1:8080", "--container", "guestbook-test",
                     "--out", str(out or self.out)]
        if conditions is not None:
            arguments.extend(["--conditions", conditions])
        arguments.extend(extra)
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(self.stdout), contextlib.redirect_stderr(self.stderr):
            return main(arguments)

    def result(self):
        return json.loads(self.out.read_text(encoding="utf-8"))

    def diagnostics(self):
        return json.loads(self.diagnostics_path.read_text(encoding="utf-8"))

    def seed_stale_success(self):
        self.out.write_text(json.dumps({"passed": True, "stale": True}), encoding="utf-8")

    def assert_failed_execution(self):
        result, diagnostics = self.result(), self.diagnostics()
        self.assertFalse(result["passed"])
        self.assertNotIn("stale", result)
        self.assertEqual(diagnostics["status"], "error")
        self.assertTrue(diagnostics["error"])
        self.assertIsNone(diagnostics["registry_digest"])
        self.assertIsNone(diagnostics["source_revision"])
        return result, diagnostics

    def test_none_pass_preserves_legacy_result_keys_and_facts(self):
        self.assertEqual(self.run_cli(), 0)
        result, diagnostics = self.result(), self.diagnostics()
        self.assertEqual(list(result), RESULT_KEYS)
        self.assertTrue(result["passed"])
        self.assertEqual(result["stage"], "test")
        self.assertEqual(result["image"], "guestbook:1")
        self.assertEqual(result["commit"], "abc1234")
        self.assertEqual(result["facts"], FACTS)
        self.assertEqual(result["replay"], [{"condition": "none", "total": 2, "matched": 2}])
        self.assertEqual(result["mismatches"], [])
        self.assertEqual(diagnostics["status"], "completed")
        self.assertTrue(diagnostics["baseline_unchanged"])
        self.assertTrue(diagnostics["facts_collected"])
        self.assertEqual(diagnostics["local_image_id"], IMAGE_ID)
        self.assertEqual(diagnostics["conditions"], [{"condition": "none", "executed": 2}])
        self.recreate.assert_called_once_with("guestbook-test")
        self.assertTrue(callable(self.replay.call_args.kwargs["on_response"]))

    def test_app_mismatch_is_exit_one_with_observed_evidence(self):
        self.replay.return_value = ReplayResult([response([]), self.responses[1]])
        self.assertEqual(self.run_cli(), 1)
        result = self.result()
        self.assertFalse(result["passed"])
        self.assertEqual(result["replay"], [{"condition": "none", "total": 2, "matched": 1}])
        self.assertEqual(len(result["mismatches"]), 1)
        self.assertEqual(result["mismatches"][0]["index"], 1)
        self.assertEqual(result["mismatches"][0]["related_fact"], "/app/data/data.db")
        self.assertEqual(self.diagnostics()["status"], "completed")

    def test_default_conditions_detect_replace_only_mismatch(self):
        self.replay.side_effect = [
            ReplayResult(self.responses),
            ReplayResult(self.responses),
            ReplayResult([response([]), self.responses[1]]),
        ]
        # --conditions를 생략해도 교체 조건을 실행하고 그 실패를 숨기지 않는다.
        self.assertEqual(self.run_cli(conditions=None), 1)
        result = self.result()
        self.assertFalse(result["passed"])
        self.assertEqual(result["replay"], [
            {"condition": "none", "total": 2, "matched": 2},
            {"condition": "restart", "total": 2, "matched": 2},
            {"condition": "replace", "total": 2, "matched": 1},
        ])
        self.assertEqual([call.kwargs["hooks"][0].name for call in self.replay.call_args_list],
                         ["none", "restart", "replace"])
        self.assertEqual(self.recreate.call_count, 3)
        self.assertEqual(len(result["mismatches"]), 1)
        self.assertEqual(result["mismatches"][0]["condition"], "replace")
        self.assertEqual(result["mismatches"][0]["index"], 1)
        self.assertEqual(result["mismatches"][0]["related_fact"], "/app/data/data.db")
        self.assertEqual(self.diagnostics()["status"], "completed")

    def test_health_failure_replaces_stale_success_and_sanitizes_exception(self):
        self.seed_stale_success()
        self.health.side_effect = TimeoutError("https://secret-token@example.invalid/healthz")
        self.assertEqual(self.run_cli(), 2)
        result, diagnostics = self.assert_failed_execution()
        self.assertEqual(result["replay"][0]["matched"], 0)
        self.assertEqual(diagnostics["error"]["phase"], "prepare")
        self.assertNotIn("secret-token", self.out.read_text(encoding="utf-8"))
        self.assertNotIn("secret-token", self.diagnostics_path.read_text(encoding="utf-8"))
        self.replay.assert_not_called()

    def test_recreate_failure_replaces_stale_success(self):
        self.seed_stale_success()
        self.recreate.side_effect = execution.docker_ops.DockerError("ENV_SECRET=private")
        self.assertEqual(self.run_cli(), 2)
        _, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["phase"], "prepare")
        self.assertFalse(diagnostics["facts_collected"])
        self.assertNotIn("ENV_SECRET", self.out.read_text(encoding="utf-8"))
        self.health.assert_not_called()
        self.replay.assert_not_called()

    def test_expected_image_mismatch_stops_before_recreate(self):
        self.assertEqual(self.run_cli(extra=("--expected-image-id", OTHER_IMAGE_ID)), 2)
        _, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["code"], "UNEXPECTED_LOCAL_IMAGE_ID")
        self.recreate.assert_not_called()
        self.replay.assert_not_called()

    def test_changed_image_between_conditions_stops_before_second_recreate(self):
        self.image_id.side_effect = [IMAGE_ID, IMAGE_ID, IMAGE_ID, IMAGE_ID, OTHER_IMAGE_ID]
        self.assertEqual(self.run_cli("none,restart"), 2)
        result, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["code"], "IMAGE_CHANGED")
        self.assertEqual(result["replay"][0], {"condition": "none", "total": 2, "matched": 2})
        self.assertEqual(result["replay"][1]["matched"], 0)
        self.assertIn("error", result["replay"][1])
        self.assertEqual(self.recreate.call_count, 1)
        self.assertEqual(self.replay.call_count, 1)

    def test_missing_record_is_execution_failure_before_docker(self):
        self.record_path.unlink()
        self.seed_stale_success()
        self.assertEqual(self.run_cli(), 2)
        self.assert_failed_execution()
        self.image_name.assert_not_called()
        self.recreate.assert_not_called()

    def test_malformed_record_is_execution_failure_before_docker(self):
        self.record_path.write_text('{"index":', encoding="utf-8")
        self.assertEqual(self.run_cli(), 2)
        self.assert_failed_execution()
        self.image_name.assert_not_called()

    def test_empty_record_cannot_pass_vacuously(self):
        self.record_path.write_text("\n \n", encoding="utf-8")
        self.assertEqual(self.run_cli(), 2)
        self.assert_failed_execution()
        self.image_name.assert_not_called()

    def test_non_contiguous_or_boolean_indices_rejected_before_docker(self):
        for indices in ((0, 1), (1, 3), (1, 1), (True, 2)):
            with self.subTest(indices=indices):
                records = copy.deepcopy(self.records)
                for item, index in zip(records, indices):
                    item["index"] = index
                self.write_records(records)
                self.assertEqual(self.run_cli(), 2)
                self.assert_failed_execution()
                self.image_name.assert_not_called()

    def test_invalid_duplicate_and_empty_conditions_rejected_before_docker(self):
        for conditions in ("not-supported", "none,none", "", " , "):
            with self.subTest(conditions=conditions):
                self.assertEqual(self.run_cli(conditions), 2)
                self.assert_failed_execution()
                self.image_name.assert_not_called()
                self.recreate.assert_not_called()

    def test_fault_position_outside_record_rejected_before_docker(self):
        self.assertEqual(self.run_cli("restart", extra=("--restart-after", "999")), 2)
        _, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["code"], "INVALID_FAULT_POSITION")
        self.image_name.assert_not_called()
        self.recreate.assert_not_called()

    def test_fault_after_last_request_rejected_before_docker(self):
        self.assertEqual(self.run_cli("replace", extra=("--restart-after", "2")), 2)
        _, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["code"], "INVALID_FAULT_POSITION")
        self.image_name.assert_not_called()
        self.recreate.assert_not_called()

    def test_one_request_cannot_claim_effective_restart_test(self):
        self.write_records(self.records[:1])
        self.assertEqual(self.run_cli("restart"), 2)
        _, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["code"], "NO_EFFECTIVE_FAULT")
        self.image_name.assert_not_called()
        self.recreate.assert_not_called()

    def test_output_cannot_overwrite_record_or_noise(self):
        for path in (self.record_path, self.noise_path):
            with self.subTest(path=path.name):
                before = path.read_bytes()
                self.assertEqual(self.run_cli(out=path), 2)
                self.assertEqual(path.read_bytes(), before)
                self.recreate.assert_not_called()

    def test_output_hardlink_to_record_is_rejected_without_overwrite(self):
        alias = self.directory / "linked-result.json"
        try:
            os.link(self.record_path, alias)
        except OSError as error:
            self.skipTest(f"Hard links unavailable: {type(error).__name__}")
        before = self.record_path.read_bytes()
        self.assertEqual(self.run_cli(out=alias), 2)
        self.assertEqual(self.record_path.read_bytes(), before)
        self.assertEqual(alias.read_bytes(), before)
        self.recreate.assert_not_called()

    def test_diagnostics_cannot_overwrite_baseline_via_hardlink(self):
        try:
            os.link(self.record_path, self.diagnostics_path)
        except OSError as error:
            self.skipTest(f"Hard links unavailable: {type(error).__name__}")
        before = self.record_path.read_bytes()
        self.assertEqual(self.run_cli(), 2)
        self.assertEqual(self.record_path.read_bytes(), before)
        self.assertFalse(self.out.exists())
        self.recreate.assert_not_called()

    def test_record_change_during_replay_aborts_and_preserves_partial_count(self):
        def changed(records, target, **kwargs):
            self.record_path.write_text(self.record_path.read_text(encoding="utf-8") + "\n",
                                        encoding="utf-8")
            try:
                kwargs["on_response"](1, records[0], self.responses[0])
            except execution.ExecutionError as error:
                return ReplayResult([self.responses[0], None], error=str(error), cause=error)
            self.fail("Baseline change must abort replay at the response observer")

        self.replay.side_effect = changed
        self.assertEqual(self.run_cli("none,restart"), 2)
        result, diagnostics = self.assert_failed_execution()
        self.assertEqual(result["replay"][0]["matched"], 1)
        self.assertFalse(diagnostics["baseline_unchanged"])
        self.assertEqual(result["replay"][1]["error"], "NOT_EXECUTED")
        self.assertEqual(self.replay.call_count, 1)
        self.collect.assert_not_called()

    def test_missing_noise_appearing_mid_run_invalidates_baseline(self):
        self.noise_path.unlink()

        def appeared(*args, **kwargs):
            self.write_noise({"rules": [], "candidates": []})
            return ReplayResult(self.responses)

        self.replay.side_effect = appeared
        self.assertEqual(self.run_cli(), 2)
        _, diagnostics = self.assert_failed_execution()
        self.assertEqual(diagnostics["error"]["code"], "BASELINE_CHANGED")
        self.assertFalse(diagnostics["baseline_unchanged"])
        self.assertIsNone(diagnostics["baseline_sha256"]["noise"])

    def test_whole_body_noise_rules_rejected_before_docker(self):
        for field in ("body", "*"):
            with self.subTest(field=field):
                self.write_noise({"rules": [{"index": 1, "fields": [field]}], "candidates": []})
                self.assertEqual(self.run_cli(), 2)
                self.assert_failed_execution()
                self.image_name.assert_not_called()
                self.recreate.assert_not_called()

    def test_interrupted_replay_keeps_partial_counts_and_unrun_condition_failure(self):
        self.replay.return_value = ReplayResult([self.responses[0], None],
                                                error="transport secret-token failed")
        self.assertEqual(self.run_cli("none,restart,replace"), 2)
        result, diagnostics = self.assert_failed_execution()
        self.assertEqual(result["replay"][0]["total"], 2)
        self.assertEqual(result["replay"][0]["matched"], 1)
        self.assertIn("REPLAY_INTERRUPTED", result["replay"][0]["error"])
        self.assertEqual(diagnostics["conditions"], [{"condition": "none", "executed": 1}])
        for entry in result["replay"][1:]:
            self.assertEqual(entry["matched"], 0)
            self.assertEqual(entry["total"], 2)
            self.assertEqual(entry["error"], "NOT_EXECUTED")
        self.assertNotIn("secret-token", self.out.read_text(encoding="utf-8"))
        self.assertEqual(self.replay.call_count, 1)
        self.collect.assert_not_called()

    def test_transport_response_error_is_execution_failure_not_app_mismatch(self):
        self.replay.return_value = ReplayResult([self.responses[0],
                                                Response(0, [], b"", error="connection refused")])
        self.assertEqual(self.run_cli(), 2)
        result, diagnostics = self.assert_failed_execution()
        self.assertEqual(result["replay"][0]["matched"], 1)
        self.assertEqual(diagnostics["error"]["code"], "REPLAY_INTERRUPTED")

    def test_facts_collection_failure_is_explicit_even_when_responses_match(self):
        self.collect.side_effect = execution.docker_ops.DockerError("container inspection failed")
        self.assertEqual(self.run_cli(), 2)
        result, diagnostics = self.assert_failed_execution()
        self.assertEqual(result["replay"][0]["matched"], 2)
        self.assertIn("error", result["replay"][0])
        self.assertEqual(result["facts"], [])
        self.assertFalse(diagnostics["facts_collected"])
        self.assertEqual(diagnostics["error"]["phase"], "facts")

    def test_local_image_and_git_commit_are_not_claimed_as_registry_provenance(self):
        self.assertEqual(self.run_cli(extra=("--expected-image-id", IMAGE_ID)), 0)
        result, diagnostics = self.result(), self.diagnostics()
        self.assertEqual(diagnostics["local_image_id"], IMAGE_ID)
        self.assertEqual(result["commit"], "abc1234")
        self.assertIsNone(diagnostics["registry_digest"])
        self.assertIsNone(diagnostics["source_revision"])
        self.assertFalse(diagnostics["target_binding_verified"])


if __name__ == "__main__":
    unittest.main()
