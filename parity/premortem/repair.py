"""AI 수정 → 복사본 적용 → 같은 기준으로 재검증 (IMPLEMENTATION_SPEC 14·15절).

- 한 번 실행에 분석·수정·재검증을 한 차례만 한다. 여전히 실패하면 결과와 수동 조치를 남기고 멈춘다.
- 재검증은 새 run_id·새 스냅샷·새 이미지로 none부터 모든 필수 조건을 다시 돌린다.
  session·noise·조건·주입 위치·초기 상태는 이전 실행과 같아야 한다.
- 통과해도 사람 검토 대기(awaiting_human_review)다. 원본 반영·merge·서명·배포는 하지 않는다.
"""

from pathlib import Path
from typing import Optional

from .ai.analyzer import analyze_run, applicable_edits
from .errors import PremortemError
from .handoff import write_handoff
from .jsonio import write_text_atomic
from .patch.guard import check_edits
from .patch.workspace import apply_to_copy
from .policy_context import load_requires, unsupported
from .report import STATUS_KO, summary_lines, write_report
from .runner import execute_run
from .snapshot import sha256_file, tree_hash, tree_listing


def ensure_same_baseline(parent_report: dict, scenario) -> None:
    baseline = parent_report["baseline"]
    if (sha256_file(scenario.session_path) != baseline["session_sha256"]
            or sha256_file(scenario.noise_path) != baseline["noise_sha256"]):
        raise PremortemError("BASELINE_CHANGED",
                             "이전 실행과 기준 기록이 다름. 같은 기준으로만 재검증하며, 기준을 바꾸려면 새 baseline 실행과 사람 검토가 필요함")


def ai_line(record: dict, note: str) -> str:
    provider = record["provider"]
    if provider == "fixture":
        return "AI: fixture (합성 예시 응답, 실제 AI 호출 아님)"
    if provider == "supplied_json":
        return "AI: supplied_json (사람이 준 JSON, 실제 AI 호출 아님)"
    if provider == "recorded_live":
        origin = record["recorded_from"]
        return f"AI: 녹화된 실제 응답 ({origin['created_at']}, {origin['model']}). 이번 실행에서 AI 호출 없음"
    usage = record["usage"]
    if record["status"] != "succeeded":
        return f"AI: {provider} 실패 {record['error_code']} ({note})"
    return (f"AI: {provider} 실제 호출, 모델 {record['model']}, 토큰 {usage['input_tokens']}/{usage['output_tokens']}, "
            f"{record['duration_ms'] / 1000:.1f}초")


def _write_review(retest, pre, record, note, patch, held_back) -> Path:
    before = {c["name"]: c for c in pre.env_report["conditions"]}
    rows = []
    for c in retest.env_report["conditions"]:
        old = before.get(c["name"])
        old_text = f"{STATUS_KO[old['status']]} {old['matched_count']}/{old['expected_count']}" if old else "-"
        rows.append(f"| {c['name']} | {old_text} | {STATUS_KO[c['status']]} {c['matched_count']}/{c['expected_count']} |")
    findings = [f"- {f['category']} (신뢰도 {f['confidence']}, 근거 {', '.join(f['evidence_ids'])}): 관측 {f['observed_fact']} "
                f"/ 원인 가설 {f['root_cause_hypothesis']}" for f in (record["output"] or {}).get("findings", [])]
    manual = [f"- {a}" for a in (record["output"] or {}).get("manual_actions", [])]
    manual += [f"- 근거·신뢰도가 부족해 자동 적용하지 않은 수정: {e['path']}" for e in held_back]
    lines = [
        f"# 수정 검토 {retest.run_id}",
        "",
        "사람이 확인하기 전에는 원본에 반영하지 않습니다. 상태: 검토 대기 (awaiting_human_review)",
        "",
        "| 항목 | 값 |",
        "| --- | --- |",
        f"| 이전 실행 | {pre.run_id} (판정 {pre.env_report['overall_status']}) |",
        f"| 다시 검사한 실행 | {retest.run_id} (판정 {retest.env_report['overall_status']}) |",
        f"| AI | {ai_line(record, note).removeprefix('AI: ')} |",
        f"| 고친 파일 | {', '.join(patch.changed_files)} (허용 경로·금지 범주·정확히 한 번 일치·수정량 검사 통과) |",
        "| 원본 앱 폴더 | 수정 전후 hash 같음. 원본은 그대로 |",
        f"| 기준 기록 | 이전 실행과 같은 session·noise, 같은 조건과 주입 위치 {retest.manifest['settings']['fault_after']} |",
        f"| 소스 | {patch.source_tree_sha256[:12]}… → {patch.patched_tree_sha256[:12]}… |",
        f"| 이미지 | {pre.env_report['image']['local_image_id'][:19]}… → {retest.env_report['image']['local_image_id'][:19]}… (새 이미지) |",
        f"| patch.diff sha256 | {patch.diff_sha256[:16]}… |",
        "",
        "## 조건별 전후",
        "",
        "| 조건 | 수정 전 | 수정 후 |",
        "| --- | --- | --- |",
        *rows,
        "",
        "## 바뀐 코드",
        "",
        "```diff",
        patch.diff_text.rstrip("\n"),
        "```",
        "",
        "## AI가 낸 원인 설명 (가설)",
        "",
        *(findings or ["- 없음"]),
        "",
        "## 남은 것",
        "",
        *(manual or ["- 없음"]),
        f"- 재생기: {retest.env_report['replay_backend']}. 수정 이미지는 로컬 재검증 결과이며 새 registry digest는 없음",
        "- 정책 판단과 서명·배포는 이 모듈이 하지 않음. 수정한 버전은 새 후보라 정책을 다시 평가해야 함",
    ]
    path = Path(retest.run_dir) / "review.md"
    write_text_atomic(path, "\n".join(lines) + "\n")
    return path


def run_repair_loop(scenario, pre, ai_mode: str, settings, docker, replay, command_runner,
                    analysis_file: Optional[Path], run_root: Optional[Path], plan_path: Optional[Path] = None) -> dict:
    result = {"ai_mode": ai_mode, "expected_outcome": False, "cleanup_failures": [], "summary": []}
    requires = ()
    if plan_path is not None:
        registry_digest = pre.env_report['image']['registry_digest']
        requires = tuple(load_requires(plan_path, pre.run_id, registry_digest,
            pre.env_report['source']['commit'] if registry_digest is not None else None))
        result["unsupported_requires"] = unsupported(list(requires))
    if pre.env_report['overall_status'] == 'passed' and not requires:
        result['summary'] = ['고칠 불일치나 정책 해결 조건이 없어 AI 분석을 하지 않음']
        return result
    record, _, note = analyze_run(pre.run_dir, scenario.allowed_edit_paths, scenario.name, ai_mode,
                                  settings.ai_timeout_sec, analysis_file, requires=requires)
    result["analysis"] = {"path": str(Path(pre.run_dir) / "analysis.json"), "provider": record["provider"],
                          "model": record["model"], "status": record["status"], "error_code": record["error_code"],
                          "usage": record["usage"], "note": note}
    result["summary"].append(ai_line(record, note))
    if record["status"] != "succeeded":
        result["summary"].append("AI 결과를 쓰지 않음. 수정과 재검증을 하지 않음")
        return result

    edits, held_back = applicable_edits(record["output"], settings.min_patch_confidence)
    if not edits:
        result["summary"].append("자동 적용할 만한 근거 있는 수정이 없음. 사람이 볼 조치만 남김")
        result["manual_actions"] = record["output"]["manual_actions"]
        return result

    app_before = tree_hash(tree_listing(scenario.app_dir)[0])
    planned = check_edits(edits, Path(pre.run_dir) / "source", scenario.allowed_edit_paths, settings)
    patch = apply_to_copy(Path(pre.run_dir) / "source", planned, Path(pre.run_dir) / "fix" / "source")
    write_text_atomic(Path(pre.run_dir) / "patch.diff", patch.diff_text)
    result["summary"].append(f"수정: {', '.join(patch.changed_files)} {len(planned)}곳, 패치 가드 통과, 복사본에만 적용")

    ensure_same_baseline(pre.env_report, scenario)
    retest = execute_run(scenario, patch.patched_root, "retest", pre.run_id, settings, docker, replay,
                         command_runner, run_root)
    result["cleanup_failures"] = list(retest.cleanup_failures)
    if tree_hash(tree_listing(scenario.app_dir)[0]) != app_before:
        raise PremortemError("SOURCE_CHANGED", "원본 앱 폴더가 바뀜. 수정은 복사본에만 적용해야 함")
    write_text_atomic(Path(retest.run_dir) / "patch.diff", patch.diff_text)
    review = _write_review(retest, pre, record, note, patch, held_back)
    write_report(retest.run_dir)
    write_handoff(retest.run_dir)

    passed = retest.env_report["overall_status"] == "passed"
    result.update({
        "retest": {"run_id": retest.run_id, "run_dir": str(retest.run_dir), "parent_run_id": pre.run_id,
                   "overall_status": retest.env_report["overall_status"],
                   "conditions": {c["name"]: c["status"] for c in retest.env_report["conditions"]},
                   "summary": summary_lines(retest.env_report)},
        "review": str(review),
        "review_status": "awaiting_human_review",
        "expected_outcome": pre.env_report["overall_status"] == "failed" and passed,
    })
    counts = ", ".join(f"{c['name']} {c['matched_count']}/{c['expected_count']} {STATUS_KO[c['status']]}"
                       for c in retest.env_report["conditions"])
    result["summary"] += [f"재검증 {retest.run_id}: {counts}",
                          f"재검증 판정: {STATUS_KO[retest.env_report['overall_status']]}, 사람 검토 대기 (review.md)"]
    return result
