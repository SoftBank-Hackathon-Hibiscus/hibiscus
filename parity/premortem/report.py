"""사람이 읽는 결과: report.md와 짧은 터미널 요약."""

from pathlib import Path

from .jsonio import load_json, load_jsonl, write_text_atomic

STATUS_KO = {"passed": "통과", "failed": "실패", "inconclusive": "판단 보류", "skipped": "건너뜀", "error": "도구 오류"}
BACKEND_KO = {"reference": "reference (개발용 샘플 전용 재생기, 윤선님 재생기 미연결)",
              "parity": "parity (윤선님 guestbook-parity)"}


def _condition_rows(env_report: dict) -> list:
    rows = []
    for c in env_report["conditions"]:
        rows.append(f"| {c['name']} | {STATUS_KO[c['status']]} | {c['matched_count']}/{c['expected_count']} "
                    f"(실행 {c['executed_count']}) | {c['reason'] or ''} |")
    return rows


def summary_lines(env_report: dict, ai_note: str = "") -> list:
    counts = ", ".join(f"{c['name']} {c['matched_count']}/{c['expected_count']} {STATUS_KO[c['status']]}"
                       for c in env_report["conditions"])
    lines = [
        f"실행 {env_report['run_id']} ({env_report['stage']})",
        f"방식: 실제 Docker, 재생 {env_report['replay_backend']}"
        + (" (샘플 전용, 윤선님 재생기 미연결)" if env_report["replay_backend"] == "reference" else ""),
        f"조건: {counts}",
    ]
    for c in env_report["conditions"]:
        for m in c["mismatches"][:2]:
            lines.append(f"  {c['name']} #{m['request_index']}: {m['summary'][:110]}")
    lines.append(f"전체 판정: {STATUS_KO[env_report['overall_status']]} ({env_report['overall_status']})")
    if ai_note:
        lines.append(ai_note)
    return lines[:10]


def write_report(run_dir: Path) -> Path:
    run_dir = Path(run_dir)
    report = load_json(run_dir / "env_report.json")
    manifest = load_json(run_dir / "run_manifest.json")
    evidence = {r["evidence_id"]: r for r in load_jsonl(run_dir / "evidence.jsonl")}
    image, source, baseline = report["image"], report["source"], report["baseline"]
    lines = [
        f"# 검사 보고서 {report['run_id']}",
        "",
        "개발용 샘플 앱을 실제 Docker에서 돌린 결과입니다. 팀 앱이나 팀 연동 결과가 아닙니다.",
        "",
        "| 항목 | 값 |",
        "| --- | --- |",
        f"| 단계 | {report['stage']}" + (f" (이전 실행 {report['parent_run_id']})" if report["parent_run_id"] else "") + " |",
        f"| 실행 방식 | {report['execution_mode']} (실제 Docker) |",
        f"| 재생 | {BACKEND_KO.get(report['replay_backend'], report['replay_backend'])} |",
        f"| 전체 판정 | {STATUS_KO[report['overall_status']]} ({report['overall_status']}) |",
        f"| 검사 범위 | 기록한 요청 {report['conditions'][0]['expected_count']}건, 조건 {', '.join(report['required_conditions'])}, "
        f"{', '.join(map(str, manifest['settings']['fault_after'])) or '없음'}번 응답 뒤 조건 주입 |",
        f"| 소스 | tree sha256 {source['tree_sha256'][:16]}…, commit {source['commit'][:12]} |",
        f"| 이미지 | {image['reference']}, 로컬 image ID {str(image['local_image_id'])[:19]}…, registry digest 없음 |",
        f"| 기준 기록 | session {baseline['session_sha256'][:12]}…, noise {baseline['noise_sha256'][:12]}… "
        f"({'실행 전후 같음' if report['baseline_integrity_verified'] else '실행 중 바뀜'}) |",
        "",
        "## 조건별 결과",
        "",
        "| 조건 | 판정 | 일치 | 이유 |",
        "| --- | --- | --- | --- |",
        *_condition_rows(report),
        "",
        "## 불일치와 근거",
        "",
    ]
    mismatches = [(c["name"], m) for c in report["conditions"] for m in c["mismatches"]]
    if not mismatches:
        lines.append("불일치 없음.")
    for name, m in mismatches:
        refs = ", ".join(m["evidence_ids"])
        lines.append(f"- {name} #{m['request_index']} ({m['kind']}): {m['summary']} [증거 {refs}]")
    lines += ["", "## 환경 증거", ""]
    for record in evidence.values():
        if record["kind"] in ("lifecycle", "file_change", "readiness", "listen_socket"):
            lines.append(f"- {record['evidence_id']}: {record['sanitized_summary']}")
    lines += ["", "## 확인하지 않은 것", ""]
    lines += [f"- {blocker}" for blocker in report["gate"]["handoff_blockers"]]
    lines.append("- 실제 Cloud Run의 인스턴스 교체를 검증한 것이 아니라, 지정한 조건(컨테이너 교체)만 재현함")
    path = run_dir / "report.md"
    write_text_atomic(path, "\n".join(lines) + "\n")
    return path
