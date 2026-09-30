import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from parity.record import encode_body
from parity.replay import ReplayResult, Response
from parity.report import build_result, evaluate, git_commit, related_fact, summary_lines

MOCK = json.loads((Path(__file__).parent.parent / "mocks" / "test_result.json").read_text(encoding="utf-8"))
FACTS = MOCK["facts"]
JSON_HEADERS = [["Content-Type", "application/json"]]


def rec(index, method, path, status, body):
    text, enc = encode_body(json.dumps(body).encode())
    return {"index": index,
            "request": {"method": method, "path": path, "headers": [], "body": "", "body_encoding": "utf8"},
            "response": {"status": status, "headers": JSON_HEADERS, "body": text, "body_encoding": enc}}


def resp(status, body):
    return Response(status, JSON_HEADERS, json.dumps(body).encode())


class RelatedFactTest(unittest.TestCase):
    def test_rules(self):
        self.assertEqual(related_fact("/posts", FACTS), "/app/data/data.db")
        self.assertEqual(related_fact("/posts/2?x=1", FACTS), "/app/data/data.db")
        self.assertEqual(related_fact("/uploads/cat.png", FACTS), "/app/uploads")
        self.assertIsNone(related_fact("/me", FACTS))        # 세션 사실은 없음 → null
        self.assertIsNone(related_fact("/healthz", FACTS))   # 규칙 없음
        self.assertIsNone(related_fact("/posts", []))        # 사실 없음
        self.assertIsNone(related_fact("/postsXYZ", FACTS))  # 접두어만 같은 경로는 아님


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self.records = [
            rec(1, "POST", "/posts", 201, {"id": 1, "created_at": "t1"}),
            rec(2, "GET", "/me", 200, {"name": "alice"}),
            rec(3, "GET", "/posts", 200, [{"id": 1, "created_at": "t1"}]),
        ]
        self.noise = {1: {"body.created_at"}, 3: {"body[*].created_at"}}

    def test_noise_only_diff_counts_as_match(self):
        result = ReplayResult([resp(201, {"id": 1, "created_at": "t9"}), resp(200, {"name": "alice"}),
                               resp(200, [{"id": 1, "created_at": "t9"}])])
        entry, mismatches = evaluate("none", self.records, result, self.noise, FACTS)
        self.assertEqual(entry, {"condition": "none", "total": 3, "matched": 3})
        self.assertEqual(mismatches, [])

    def test_mismatch_entries(self):
        result = ReplayResult([resp(201, {"id": 1, "created_at": "t9"}), resp(401, {"error": "login required"}),
                               resp(200, [])])
        entry, mismatches = evaluate("restart", self.records, result, self.noise, FACTS)
        self.assertEqual(entry["matched"], 1)
        self.assertEqual([(m["index"], m["request"], m["related_fact"]) for m in mismatches],
                         [(2, "GET /me", None), (3, "GET /posts", "/app/data/data.db")])
        self.assertEqual(mismatches[0]["expected"], '200 {"name":"alice"}')
        self.assertEqual(mismatches[0]["actual"], '401 {"error":"login required"}')

    def test_aborted_replay(self):
        result = ReplayResult([resp(201, {"id": 1, "created_at": "t9"}), None, None], error="재시작 실패")
        entry, mismatches = evaluate("restart", self.records, result, self.noise, FACTS)
        self.assertEqual(entry, {"condition": "restart", "total": 3, "matched": 1, "error": "재시작 실패"})


class ResultShapeTest(unittest.TestCase):
    """실제 결과가 mocks/test_result.json 과 같은 모양인지 (키 순서·타입)."""

    def test_same_shape_as_mock(self):
        entries = [{"condition": "none", "total": 20, "matched": 20},
                   {"condition": "restart", "total": 20, "matched": 19}]
        mismatches = [{"condition": "restart", "index": 12, "request": "GET /posts",
                       "expected": "200 []", "actual": "200 []", "related_fact": None}]
        result = build_result("guestbook:1", FACTS, entries, mismatches, commit="abc1234")
        self.assertEqual(list(result), list(MOCK))
        for key in MOCK:
            self.assertIsInstance(result[key], type(MOCK[key]), key)
        self.assertEqual(list(result["replay"][0]), list(MOCK["replay"][0]))
        self.assertEqual(list(result["mismatches"][0]), list(MOCK["mismatches"][0]))
        self.assertFalse(result["passed"])

    def test_passed_only_when_everything_matches(self):
        ok = [{"condition": "none", "total": 20, "matched": 20}]
        self.assertTrue(build_result("i", [], ok, [], commit="x")["passed"])
        self.assertFalse(build_result("i", [], [], [], commit="x")["passed"])
        aborted = [{"condition": "restart", "total": 20, "matched": 20, "error": "boom"}]
        self.assertFalse(build_result("i", [], aborted, [], commit="x")["passed"])

    def test_summary_line(self):
        result = dict(MOCK, mismatches=MOCK["mismatches"] * 3)
        self.assertEqual(summary_lines(result), ["none: 20/20, restart: 17/20, 불일치 3건"])


@unittest.skipUnless(shutil.which("git"), "git 이 없음")
class GitCommitTest(unittest.TestCase):
    """commit 은 작업 트리가 HEAD 와 정확히 같을 때만 기록한다."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = self._tmp.name
        self.git("init", "-q")
        Path(self.repo, "app.py").write_text("print(1)\n", encoding="utf-8")
        self.git("add", "app.py")
        self.git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def test_clean_tree_reports_head(self):
        commit, _ = git_commit(self.repo)
        self.assertEqual(commit, self.git("rev-parse", "--short", "HEAD").strip())

    def test_untracked_file_means_unknown(self):
        Path(self.repo, "new_module.py").write_text("x = 1\n", encoding="utf-8")
        commit, why = git_commit(self.repo)
        self.assertEqual(commit, "unknown")
        self.assertIn("미추적 파일 1개", why)

    def test_modified_tracked_file_means_unknown(self):
        Path(self.repo, "app.py").write_text("print(2)\n", encoding="utf-8")
        self.assertEqual(git_commit(self.repo)[0], "unknown")

    def test_not_a_repository_means_unknown(self):
        with tempfile.TemporaryDirectory() as other:
            self.assertEqual(git_commit(other)[0], "unknown")


if __name__ == "__main__":
    unittest.main()
