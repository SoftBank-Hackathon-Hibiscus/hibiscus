"""명령줄 입구. --json이면 stdout에 JSON 요약 하나만 내고 진행 로그는 stderr로 보낸다.

종료 코드: 0 성공, 1 잘못된 입력·실행 오류, 2 필요한 입력·팀 연결·권한 없음, 3 검사 실패·패치 거부.
demo의 0은 "설계한 결함과 수정 동작을 확인했다"는 뜻이며, 결함 앱의 env_report는 failed로 남는다.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence

from . import __version__
from .config import Settings
from .errors import EXIT_ERROR, EXIT_FAILED, EXIT_INCOMPLETE, EXIT_OK, PremortemError

AI_MODES = ("off", "fixture", "json-file", "live", "recorded")


def _print_json(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def _cmd_doctor(args) -> int:
    from .doctor import run_doctor

    report = run_doctor()
    if args.json:
        _print_json(report)
    else:
        for name, check in report["checks"].items():
            extra = check.get("version") or check.get("model") or ""
            print(f"{name:16} {check['status']:12} {check['reason']} {extra}".rstrip())
    return EXIT_OK


def _cmd_demo(args) -> int:
    from .demo import run_demo

    if args.ai in ("json-file", "recorded") and not args.analysis_file:
        raise PremortemError("INPUT_INVALID", f"--ai {args.ai}에는 --analysis-file이 필요함")
    if args.analysis_file and args.ai not in ("json-file", "recorded"):
        raise PremortemError("INPUT_INVALID", "--analysis-file은 --ai json-file 또는 recorded와 함께만 씀")
    settings = Settings()
    result = run_demo(args.scenario, args.ai, settings, Path(args.analysis_file) if args.analysis_file else None,
                      Path(args.run_root) if args.run_root else None, Path(args.plan) if args.plan else None)
    if args.json:
        _print_json(result)
    else:
        print("\n".join(result["pretest"]["summary"]))
        repair = result.get("repair")
        if repair:
            print("\n".join(repair.get("summary", [])))
    if result["cleanup_failures"]:
        print("정리하지 못한 자기 컨테이너: " + ", ".join(c[:12] for c in result["cleanup_failures"])
              + " → docker rm --force <ID>로 직접 지워 주세요", file=sys.stderr)
        return EXIT_ERROR
    ok = result["pretest_matches_design"] and (result.get("repair") is None or result["repair"].get("expected_outcome"))
    return EXIT_OK if ok else EXIT_FAILED


def _cmd_report(args) -> int:
    from .jsonio import load_json
    from .report import summary_lines, write_report

    run_dir = Path(args.run_dir)
    path = write_report(run_dir)
    report = load_json(run_dir / "env_report.json")
    if args.json:
        _print_json({"report": str(path), "overall_status": report["overall_status"]})
    else:
        print("\n".join(summary_lines(report)))
        print(f"보고서: {path}")
    return EXIT_OK


def _cmd_handoff(args) -> int:
    from .handoff import verify_handoff, write_handoff

    run_dir = Path(args.run_dir)
    write_handoff(run_dir)
    bundle = verify_handoff(run_dir)
    if args.json:
        _print_json(bundle)
    else:
        print(f"인계 묶음: {run_dir / 'handoff_bundle.json'} (mode={bundle['mode']}, ready_for_policy={bundle['ready_for_policy']})")
        for blocker in bundle["blockers"]:
            print(f"  미완료: {blocker}")
    # 팀 연동 전에는 정책 입력으로 넘길 수 없으므로 완료(0)로 보고하지 않는다.
    return EXIT_OK if bundle["ready_for_policy"] else EXIT_INCOMPLETE


def _cmd_run(args) -> int:
    from .adapters.parity_adapter import load_parity_adapter

    load_parity_adapter(Path.cwd())  # 윤선님 재생기 없이는 실제 앱을 검사하지 않는다
    return EXIT_INCOMPLETE


def _cmd_self_test(args) -> int:
    env = dict(os.environ)
    if args.docker:
        env["PREMORTEM_DOCKER_TESTS"] = "1"
    root = Path(__file__).resolve().parents[1]
    command = [sys.executable, "-m", "unittest", "discover", "-s", "tests/premortem", "-t", ".", "-p", "test_*.py"]
    if args.verbose:
        command.append("-v")
    return subprocess.run(command, cwd=root, env=env).returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m premortem",
        description="배포 환경 조건(restart·replace·바인딩) 재현, AI 수정 제안, 같은 기록으로 재검증",
    )
    parser.add_argument("--version", action="version", version=f"premortem {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="실행 환경과 팀 모듈 연결 가능 여부 점검")
    doctor.add_argument("--json", action="store_true", help="JSON 요약만 stdout으로 출력")
    doctor.set_defaults(handler=_cmd_doctor)

    demo = sub.add_parser("demo", help="개발용 샘플로 실제 Docker 시연")
    demo.add_argument("--scenario", required=True, choices=("state-loss", "binding"))
    demo.add_argument("--ai", default="off", choices=AI_MODES, help="binding 수정 단계의 AI 방식")
    demo.add_argument("--analysis-file", help="--ai json-file 또는 recorded일 때 읽을 analysis.json")
    demo.add_argument("--run-root", help="실행 결과를 둘 폴더 (기본 premortem/.runs)")
    demo.add_argument("--plan", help="류진님 정책 결과(plan.json). requires를 AI 수정 목표로 읽음")
    demo.add_argument("--json", action="store_true")
    demo.set_defaults(handler=_cmd_demo)

    report = sub.add_parser("report", help="실행 폴더의 report.md를 다시 만들고 요약 출력")
    report.add_argument("--run-dir", required=True)
    report.add_argument("--json", action="store_true")
    report.set_defaults(handler=_cmd_report)

    handoff = sub.add_parser("handoff", help="정책 파트용 인계 묶음을 만들고 hash 확인")
    handoff.add_argument("--run-dir", required=True)
    handoff.add_argument("--json", action="store_true")
    handoff.set_defaults(handler=_cmd_handoff)

    run = sub.add_parser("run", help="실제 앱 검사 (윤선님 재생기 연결 후 사용)")
    run.add_argument("--json", action="store_true")
    run.set_defaults(handler=_cmd_run)

    self_test = sub.add_parser("self-test", help="단위 테스트 실행. --docker면 실제 Docker 시험 포함")
    self_test.add_argument("--docker", action="store_true")
    self_test.add_argument("-v", "--verbose", action="store_true")
    self_test.set_defaults(handler=_cmd_self_test)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except PremortemError as error:
        print(f"오류 {error.code}: {error.message}", file=sys.stderr)
        if getattr(args, "json", False):
            _print_json({"status": "error", "error_code": error.code, "message": error.message})
        return error.exit_code
    except KeyboardInterrupt:
        print("중단됨", file=sys.stderr)
        return EXIT_ERROR
