"""3-B. 결과 JSON 만들기 (형식은 mocks/test_result.json 과 같다).

related_fact: 불일치한 요청의 경로를 보고 관련 있어 보이는 사실(fact)의 path 를 붙인다.
원인을 증명하는 것이 아니라 "여기부터 보라"는 힌트다. 규칙은 RELATED_RULES 한 곳에 있다.

commit: 실행 폴더 아래 작업 트리가 HEAD 와 **정확히 같을 때만** 커밋 해시를 쓴다.
수정·미추적 파일이 하나라도 있으면 "unknown" — 검사한 코드가 그 커밋에 없을 수 있기 때문이다.
깨끗한 커밋이어도 "이미지가 그 커밋으로 빌드됐다"는 증명은 아니다 (README 알려진 한계 참고).
"""
import re
import subprocess

from .compare import render, significant_diffs, view_recorded, view_replayed
from .record import request_label

# (요청 경로 정규식, 연결할 사실 종류). 위에서부터 처음 맞는 규칙 하나만 쓴다.
# 세션은 프로세스 메모리에 있어서 facts 로 잡히지 않는다 → 해당 종류의 사실이 없으면 null.
RELATED_RULES = [
    (re.compile(r"^/posts(?:/|$)"), "sqlite"),
    (re.compile(r"^/uploads(?:/|$)"), "local_upload"),
    (re.compile(r"^/(?:me|login|logout)(?:/|$)"), "session"),
]


def related_fact(path, facts):
    path = path.split("?", 1)[0]
    for pattern, kind in RELATED_RULES:
        if pattern.match(path):
            return next((f["path"] for f in facts if f["kind"] == kind), None)
    return None


def evaluate(condition, records, replay_result, noise_by_index, facts):
    """한 조건의 재생 결과를 기록과 비교 → (replay 항목, mismatches 목록)."""
    matched, mismatches = 0, []
    for rec, resp in zip(records, replay_result.responses):
        if resp is None:
            continue  # 재생이 중단되어 보내지 못한 요청. replay 항목의 error 에 이유가 남는다.
        expected, actual = view_recorded(rec["response"]), view_replayed(resp)
        if not significant_diffs(expected, actual, noise_by_index.get(rec["index"], ())):
            matched += 1
            continue
        mismatches.append({
            "condition": condition,
            "index": rec["index"],
            "request": request_label(rec),
            "expected": render(expected),
            "actual": render(actual),
            "related_fact": related_fact(rec["request"]["path"], facts),
        })
    entry = {"condition": condition, "total": len(records), "matched": matched}
    if replay_result.error:
        entry["error"] = replay_result.error
    return entry, mismatches


def git_commit(path="."):
    """(commit, 설명). path 아래 작업 트리가 HEAD 와 같을 때만 짧은 커밋 해시, 아니면 "unknown"."""
    def git(*args):
        return subprocess.run(["git", *args], cwd=path, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=10)
    try:
        head = git("rev-parse", "--short", "HEAD")
        if head.returncode != 0 or not head.stdout.strip():
            return "unknown", "git 저장소가 아니거나 커밋이 없음"
        status = git("status", "--porcelain", "--untracked-files=all", "--", ".")
    except (OSError, subprocess.SubprocessError):
        return "unknown", "git 을 실행할 수 없음"
    if status.returncode != 0:
        return "unknown", "git status 실패"
    changed = [line for line in status.stdout.splitlines() if line.strip()]
    if changed:
        untracked = sum(1 for line in changed if line.startswith("??"))
        return "unknown", (f"커밋되지 않은 변경 {len(changed) - untracked}개, 미추적 파일 {untracked}개가 있어 "
                           f"HEAD({head.stdout.strip()})가 검사한 코드를 대표하지 않음")
    return head.stdout.strip(), "작업 트리가 HEAD 와 같음 (이미지가 이 커밋으로 빌드됐는지는 확인하지 않음)"


def build_result(image, facts, entries, mismatches, commit, stage="test"):
    passed = bool(entries) and all(e["matched"] == e["total"] and "error" not in e for e in entries)
    return {
        "stage": stage,
        "commit": commit,
        "image": image,
        "passed": passed,
        "facts": facts,
        "replay": entries,
        "mismatches": mismatches,
    }


def summary_lines(result):
    """예: ['none: 20/20, restart: 17/20, 불일치 3건']"""
    parts = [f"{e['condition']}: {e['matched']}/{e['total']}" for e in result["replay"]]
    lines = [", ".join(parts + [f"불일치 {len(result['mismatches'])}건"])]
    lines += [f"{e['condition']} 재생 중단: {e['error']}" for e in result["replay"] if e.get("error")]
    return lines
