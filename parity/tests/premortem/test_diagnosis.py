import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from premortem.ai.provider import AnalysisResult
from premortem.ai.schema_subset import api_subset
from premortem.diagnosis import analyze, build_input, canonical, check_output, hide_python_notes, main, render_report, sanitized
from premortem.errors import PremortemError
from premortem.jsonio import load_json
from premortem.snapshot import sha256_bytes, sha256_file

FIXTURE = Path(__file__).resolve().parents[2] / "examples" / "diagnosis" / "guestbook"


def output_for(payload):
    return {"findings": [{
        "id": "F1", "title": "Test-only hypothesis", "observed": "Observed mismatch",
        "hypothesis": "Not a real model response", "mismatch_ids": [m["id"] for m in payload["mismatches"]],
        "fact_ids": [payload["facts"][0]["id"]],
        "source_locations": [{"path": "app.py", "line_start": 48, "line_end": 49}],
        "scope": "unknown", "next_action": "Investigate", "verification": "Replay", "limit": "Unproven",
    }], "unexplained_mismatch_ids": []}


class DiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        shutil.copytree(FIXTURE, self.bundle)
        self.payload = build_input(self.bundle, ["app.py"])

    def rehash(self, name):
        path = self.bundle / "execution_manifest.json"
        execution = load_json(path)
        execution["artifacts"][name] = sha256_file(self.bundle / name)
        path.write_text(json.dumps(execution))

    def test_actual_bundle_and_blind_input(self):
        self.assertEqual(13, len(self.payload["mismatches"]))
        text = self.payload["sources"][0]["content"]
        self.assertNotIn("결함", text)
        self.assertNotIn("엔드포인트", text)
        self.assertIn("DROP TABLE IF EXISTS posts;", text)
        self.assertEqual("SESSIONS = {}", text.splitlines()[57])
        self.assertEqual(237, len(text.splitlines()))
        self.assertFalse(self.payload["policy_hints_included"])

    def test_schema_keeps_fields_named_like_annotation_keywords(self):
        from premortem.diagnosis import OUTPUT_SCHEMA
        converted = api_subset(OUTPUT_SCHEMA)
        finding = converted["properties"]["findings"]["items"]
        self.assertIn("title", finding["properties"])
        self.assertEqual(set(finding["required"]), set(finding["properties"]))
        self.assertNotIn("maxLength", finding["properties"]["title"])

    def test_recorded_live_analysis_still_matches_original_input(self):
        record = load_json(FIXTURE.parent / "guestbook-analysis.json")
        self.assertEqual("anthropic_messages", record["provider"])
        self.assertEqual("succeeded", record["status"])
        self.assertEqual(record["input_sha256"], sha256_bytes(canonical(self.payload).encode()))
        check_output(record["output"], self.payload)

    def test_comment_tokens_inside_strings_are_not_erased(self):
        source = '"""answer"""\nvalue = "# keep me" # hide me\nsql = """DROP TABLE posts;"""\n'
        hidden = hide_python_notes(source)
        self.assertEqual(source.count("\n"), hidden.count("\n"))
        self.assertIn('"# keep me"', hidden)
        self.assertIn('"""DROP TABLE posts;"""', hidden)
        self.assertNotIn('answer', hidden)
        self.assertNotIn('hide me', hidden)

    def test_nested_json_response_is_redacted_before_serialization(self):
        data = [{"expected": '200 {"api_key":"private-value", "ok":true}', "index": 2}]
        result = sanitized(data)
        self.assertNotIn("private-value", canonical(result))
        self.assertIn("[REDACTED]", result[0]["expected"])
        self.assertEqual(2, result[0]["index"])

    def test_docstrings_with_unicode_columns(self):
        source = 'def 함수(): """정답은 비밀"""; return "보존"\n'
        hidden = hide_python_notes(source)
        self.assertNotIn('정답', hidden)
        self.assertIn('return "보존"', hidden)

    def test_changed_result_is_rejected_before_model_call(self):
        with (self.bundle / "result.json").open("a") as f:
            f.write(" ")
        with self.assertRaises(PremortemError):
            build_input(self.bundle, ["app.py"])

    def test_changed_source_is_rejected(self):
        with (self.bundle / "source" / "app.py").open("a") as f:
            f.write("\nSESSIONS = {'x': 'y'}\n")
        with self.assertRaises(PremortemError):
            build_input(self.bundle, ["app.py"])

    def test_different_image_is_rejected_even_if_artifact_hash_updated(self):
        path = self.bundle / "build_manifest.json"
        build = load_json(path)
        build["image"]["local_image_id"] = "sha256:" + "0" * 64
        path.write_text(json.dumps(build))
        self.rehash("build_manifest.json")
        with self.assertRaises(PremortemError):
            build_input(self.bundle, ["app.py"])

    def test_path_traversal_and_symlink_rejected(self):
        with self.assertRaises(PremortemError):
            build_input(self.bundle, ["../source/app.py"])
        (self.bundle / "source" / "link.py").symlink_to(self.bundle / "source" / "app.py")
        with self.assertRaises(PremortemError):
            build_input(self.bundle, ["link.py"])

    def test_reference_integrity_and_complete_coverage(self):
        valid = output_for(self.payload)
        check_output(valid, self.payload)
        for mutate in [
            lambda f: f.update(mismatch_ids=["replace:999"]),
            lambda f: f.update(fact_ids=["invented"]),
            lambda f: f["source_locations"][0].update(line_start=900, line_end=901),
            lambda f: f["source_locations"][0].update(line_start=1, line_end=10),
            lambda f: f["source_locations"][0].update(path="passwords.py"),
        ]:
            output = copy.deepcopy(valid)
            mutate(output["findings"][0])
            with self.assertRaises(PremortemError):
                check_output(output, self.payload)

    def test_unexplained_must_not_overlap_or_omit(self):
        output = output_for(self.payload)
        missing = output["findings"][0]["mismatch_ids"].pop()
        with self.assertRaises(PremortemError):
            check_output(output, self.payload)
        output["unexplained_mismatch_ids"] = [missing]
        check_output(output, self.payload)
        output["findings"][0]["mismatch_ids"].append(missing)
        with self.assertRaises(PremortemError):
            check_output(output, self.payload)

    def test_rejected_output_retained_but_never_presented_as_analysis(self):
        output = output_for(self.payload)
        output["findings"][0]["fact_ids"] = ["invented"]
        class FakeProvider:
            def analyze(self, *_args):
                return AnalysisResult("unit_test", "fake", "succeeded", output)
        rejected = self.root / "rejected.json"
        record = analyze(self.payload, FakeProvider(), rejected)
        self.assertEqual("invalid", record["status"])
        self.assertIsNone(record["output"])
        self.assertEqual(output, load_json(rejected)["output"])

    def test_html_does_not_allow_script_termination_from_data(self):
        payload = copy.deepcopy(self.payload)
        payload["mismatches"][0]["actual"] = '</script><script>alert("xss")</script>'
        html = render_report(payload, None)
        self.assertNotIn('</script><script>alert', html)
        self.assertIn('\\u003c/script>', html)
        self.assertNotIn('innerHTML', html)

    def test_prepare_has_no_model_call_and_does_not_overwrite(self):
        out = self.root / "report"
        args = ["--bundle", str(self.bundle), "--source", "app.py", "--out", str(out)]
        self.assertEqual(0, main(args))
        self.assertFalse((out / "diagnosis.json").exists())
        self.assertTrue((out / "index.html").exists())
        self.assertEqual(1, main(args))

    def test_unrelated_recording_rejected(self):
        recording = self.root / "record.json"
        recording.write_text(json.dumps({"format": "hibiscus-diagnosis-record-v1", "provider": "anthropic_messages",
            "status": "succeeded", "run_id": "other-run", "input_sha256": "wrong", "output": output_for(self.payload)}))
        out = self.root / "report"
        self.assertEqual(1, main(["--bundle", str(self.bundle), "--source", "app.py", "--out", str(out), "--recorded", str(recording)]))
        self.assertFalse((out / "index.html").exists())


if __name__ == "__main__":
    unittest.main()
