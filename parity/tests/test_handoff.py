import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from parity.handoff import FORMAT, build_envelope, canonical_result_bytes, write_handoff


METADATA = {"run_id": "r-20261001-01", "app": "guestbook", "source_revision": "a" * 40,
            "digest": "sha256:" + "b" * 64}
ROOT = Path(__file__).resolve().parent.parent


def passing():
    return {"stage": "test", "commit": "unknown", "image": "guestbook:1", "passed": True,
            "facts": [], "replay": [{"condition": "none", "total": 2, "matched": 2}], "mismatches": []}


def encoded(result):
    return json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8")


def envelope(result, metadata=None):
    return build_envelope(encoded(result), "result.json", metadata or METADATA)


class HandoffValidationTest(unittest.TestCase):
    def test_real_failed_demo_preserved_not_normalized(self):
        raw = (ROOT / "examples" / "demo_result.json").read_bytes()
        result = json.loads(raw)
        before = copy.deepcopy(result)
        out = build_envelope(raw, "demo_result.json", METADATA)
        self.assertEqual(out["format"], FORMAT)
        self.assertEqual(out["result"], before)
        self.assertFalse(out["result"]["passed"])
        self.assertIsInstance(out["result"]["facts"], list)
        self.assertEqual([e["matched"] for e in out["result"]["replay"]], [20, 14])
        self.assertEqual(out["metadata"], METADATA)
        self.assertFalse(out["provenance"]["image_verified"])
        self.assertEqual(out["provenance"]["status"], "caller_asserted")
        self.assertEqual(out["result_artifact"]["sha256"], "sha256:" + hashlib.sha256(raw).hexdigest())
        self.assertEqual(out["result_artifact"]["byte_length"], len(raw))
        digest = hashlib.sha256(canonical_result_bytes(out["result"])).hexdigest()
        self.assertEqual(out["result_sha256"], "sha256:" + digest)

    def test_passing_result_and_extra_evidence_preserved(self):
        result = passing()
        result["observations"] = {"note": "원본 근거", "items": [1, 2]}
        self.assertEqual(envelope(result)["result"], result)

    def test_no_revision_inference_from_tool_commit(self):
        result = passing()
        result["commit"] = "1234567"
        out = envelope(result)
        self.assertEqual(out["result"]["commit"], "1234567")
        self.assertEqual(out["metadata"]["source_revision"], METADATA["source_revision"])

    def test_aborted_replay_does_not_require_mismatches_for_unissued_requests(self):
        result = passing()
        result["passed"] = False
        result["replay"][0].update(matched=1, error="restart health timeout")
        self.assertEqual(envelope(result)["result"], result)

    def test_error_even_after_all_matches_cannot_pass(self):
        result = passing()
        result["replay"][0]["error"] = "hook failed after response"
        with self.assertRaisesRegex(ValueError, "passed conflicts"):
            envelope(result)
        result["passed"] = False
        self.assertFalse(envelope(result)["result"]["passed"])

    def test_verify_result_rejected(self):
        result = passing()
        result["stage"] = "verify"
        with self.assertRaisesRegex(ValueError, "pre-deploy"):
            envelope(result)

    def test_invalid_explicit_metadata_rejected(self):
        bad = [("run_id", "bad/id"), ("run_id", "a" * 65), ("run_id", ""),
               ("app", "  "), ("source_revision", "unknown"), ("source_revision", "ABCDEF0"),
               ("source_revision", "123456"), ("digest", "guestbook:1"),
               ("digest", "sha256:" + "B" * 64), ("digest", "sha256:" + "b" * 63)]
        for key, value in bad:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                envelope(passing(), dict(METADATA, **{key: value}))

    def test_conflicting_embedded_identity_rejected(self):
        for key in METADATA:
            result = passing()
            result[key] = "different"
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "conflicts"):
                envelope(result)
        result = passing()
        result["source_revision"] = METADATA["source_revision"][:7]
        with self.assertRaisesRegex(ValueError, "conflicts"):
            envelope(result)

    def test_matching_embedded_identity_or_unknown_revision_preserved(self):
        result = dict(passing(), **METADATA)
        self.assertEqual(envelope(result)["result"], result)
        result["source_revision"] = "unknown"
        self.assertEqual(envelope(result)["result"]["source_revision"], "unknown")

    def test_empty_zero_boolean_overflow_and_duplicate_conditions_rejected(self):
        results = []
        item = passing()
        item["replay"] = []
        results.append(item)
        for field, value in (("total", 0), ("total", True), ("matched", False),
                             ("total", 2.0), ("matched", 3), ("matched", -1), ("error", "")):
            item = passing()
            item["replay"][0][field] = value
            results.append(item)
        item = passing()
        item["replay"] *= 2
        results.append(item)
        for item in results:
            with self.subTest(item=item), self.assertRaises(ValueError):
                envelope(item)

    def test_completed_unmatched_requests_need_corresponding_mismatches(self):
        result = passing()
        result["passed"] = False
        result["replay"][0]["matched"] = 1
        with self.assertRaisesRegex(ValueError, "mismatch count"):
            envelope(result)
        result["mismatches"] = [{"condition": "none", "index": 2, "request": "GET /posts",
                                 "expected": "200 []", "actual": "500 error", "related_fact": None}]
        self.assertFalse(envelope(result)["result"]["passed"])
        result["mismatches"] *= 2
        with self.assertRaisesRegex(ValueError, "duplicate mismatch"):
            envelope(result)

    def test_mismatch_cannot_reference_unknown_condition(self):
        result = passing()
        result["mismatches"] = [{"condition": "replace", "index": 1}]
        with self.assertRaisesRegex(ValueError, "unknown condition"):
            envelope(result)

    def test_mismatch_cannot_reference_unrecorded_request_number(self):
        result = passing()
        result["passed"] = False
        result["replay"][0]["matched"] = 1
        result["mismatches"] = [{"condition": "none", "index": 999, "request": "GET /posts",
                                 "expected": "200 []", "actual": "500 error", "related_fact": None}]
        with self.assertRaisesRegex(ValueError, "between 1"):
            envelope(result)

    def test_false_pass_flag_without_failure_rejected(self):
        result = passing()
        result["passed"] = False
        with self.assertRaisesRegex(ValueError, "passed conflicts"):
            envelope(result)

    def test_duplicate_json_keys_and_nonstandard_constants_rejected(self):
        for raw in (b'{"stage":"test","stage":"verify"}', b'{"score":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                build_envelope(raw, "result.json", METADATA)

    def test_hashes_distinguish_file_format_from_result_content(self):
        result = passing()
        first = encoded(result)
        second = json.dumps(result, separators=(",", ":")).encode()
        a, b = [build_envelope(raw, "result.json", METADATA) for raw in (first, second)]
        self.assertNotEqual(a["result_artifact"]["sha256"], b["result_artifact"]["sha256"])
        self.assertEqual(a["result_sha256"], b["result_sha256"])
        result["image"] = "guestbook:2"
        self.assertNotEqual(a["result_sha256"], envelope(result)["result_sha256"])


class HandoffWriteTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "result.json"
        self.raw = encoded(passing())
        self.source.write_bytes(self.raw)
        self.target = self.root / "handoff.json"

    def test_output_is_snapshot_and_original_file_is_unchanged(self):
        out = write_handoff(self.source, self.target, **METADATA)
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertEqual(json.loads(self.target.read_text(encoding="utf-8")), out)
        self.source.write_text("changed later", encoding="utf-8")
        self.assertTrue(json.loads(self.target.read_text(encoding="utf-8"))["result"]["passed"])

    def test_same_input_output_rejected(self):
        with self.assertRaisesRegex(ValueError, "replace input"):
            write_handoff(self.source, self.source, **METADATA)
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_hardlink_output_to_input_rejected(self):
        try:
            os.link(self.source, self.target)
        except OSError as exc:
            self.skipTest(f"hardlink unavailable: {exc}")
        with self.assertRaisesRegex(ValueError, "alias input"):
            write_handoff(self.source, self.target, **METADATA)
        self.assertEqual(self.source.read_bytes(), self.raw)

    def test_validation_failure_keeps_existing_output(self):
        self.target.write_text("old valid output", encoding="utf-8")
        self.source.write_bytes(b"invalid JSON")
        with self.assertRaises(ValueError):
            write_handoff(self.source, self.target, **METADATA)
        self.assertEqual(self.target.read_text(), "old valid output")

    def test_atomic_replace_failure_preserves_output_and_cleans_tempfile(self):
        self.target.write_text("old output", encoding="utf-8")
        with patch("parity.handoff.os.replace", side_effect=OSError("replace failed")):
            with self.assertRaises(OSError):
                write_handoff(self.source, self.target, **METADATA)
        self.assertEqual(self.target.read_text(), "old output")
        self.assertEqual(list(self.root.glob(".parity-handoff-*.tmp")), [])

    def test_cli_packaging_success_does_not_claim_failed_test_passed(self):
        self.source.write_bytes((ROOT / "examples" / "demo_result.json").read_bytes())
        command = [sys.executable, "-m", "parity.handoff", "--result", str(self.source),
                   "--run-id", METADATA["run_id"], "--app", METADATA["app"],
                   "--source-revision", METADATA["source_revision"], "--digest", METADATA["digest"],
                   "--out", str(self.target)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("test passed=false", result.stdout)
        self.assertIn("caller-asserted", result.stderr)
        self.assertFalse(json.loads(self.target.read_text(encoding="utf-8"))["result"]["passed"])
        command[command.index("--digest") + 1] = "guestbook:1"
        invalid = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(invalid.returncode, 2)
        self.assertIn("invalid digest", invalid.stderr)


if __name__ == "__main__":
    unittest.main()
