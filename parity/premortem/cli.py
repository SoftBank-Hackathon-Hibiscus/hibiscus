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


def _cmd_build(args) -> int:
    from .process import SubprocessRunner
    from .registry_build import build_and_push

    result = build_and_push(app=Path(args.app), image_repo=args.image_repo, out_dir=Path(args.out_dir),
                            run_id=args.run_id, platforms=tuple(args.platforms.split(",")),
                            builder=args.builder, timeout=args.timeout, runner=SubprocessRunner())
    if args.json:
        _print_json(result)
    else:
        print(f"이미지: {result['image']['reference']}")
        print(f"소스: {result['source']['commit']}")
        print(f"빌드 기록: {Path(args.out_dir) / 'build_manifest.json'}")
    return EXIT_OK


def _cmd_test_build(args) -> int:
    from .built_test import test_build
    from .process import SubprocessRunner

    try:
        after = tuple(int(value) for value in args.after.split(',')) if args.after else ()
    except ValueError:
        raise PremortemError('INPUT_INVALID', '--after는 쉼표로 구분한 요청 번호여야 함') from None
    result = test_build(manifest_path=args.build_manifest, record=args.record, noise=args.noise,
                        app=args.name, out_dir=args.out_dir, runner=SubprocessRunner(),
                        run_id=args.run_id, revision=args.source_revision, digest=args.digest,
                        port=args.port, health_path=args.health_path, health_timeout=args.health_timeout,
                        after=after)
    if args.json:
        _print_json(result)
    else:
        print(f"검사: {result['status']}, passed={result['passed']} ({args.out_dir})")
    if result['status'] != 'completed':
        return EXIT_ERROR
    return EXIT_OK if result['passed'] else EXIT_FAILED


def _cmd_policy_preview(args) -> int:
    from .policy_preview import preview_policy

    result = preview_policy(args.test_dir, args.out_dir, args.policy_root)
    if args.json:
        _print_json(result)
    else:
        print(f"정책: {result['decision']} ({result['plan_path']})")
    return result['exit_code']


def _cmd_backend_test(args) -> int:
    from .backend_test import run_backend_test

    result = run_backend_test(args.request, args.out_dir, args.policy_root)
    _print_json(result)
    return EXIT_OK


def _cmd_repair_build(args) -> int:
    from .repair_build import repair_build

    try:
        after = tuple(int(value) for value in args.after.split(',')) if args.after else ()
    except ValueError:
        raise PremortemError('INPUT_INVALID', '--after는 요청 번호여야 함') from None
    result = repair_build(manifest_path=args.build_manifest, record=args.record, noise=args.noise,
        name=args.name, out_dir=args.out_dir, allowed=tuple(args.allow_edit), ai_mode=args.ai,
        analysis_file=args.analysis_file, plan=args.plan, port=args.port, health_path=args.health_path,
        health_timeout=args.health_timeout, after=after)
    if args.json:
        _print_json(result)
    else:
        print('\n'.join(result['summary']))
    if result['cleanup_failures']:
        return EXIT_ERROR
    if result.get('analysis', {}).get('status') != 'succeeded' or not result.get('retest'):
        return EXIT_INCOMPLETE
    return EXIT_OK if result['retest']['overall_status'] == 'passed' else EXIT_FAILED


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
    import re

    from .adapters.parity_adapter import load_parity_adapter
    from .config import CORE_CONDITIONS
    from .docker_driver import DockerDriver
    from .handoff import write_handoff
    from .paths import validate_run_id
    from .process import SubprocessRunner
    from .report import summary_lines, write_report
    from .runner import execute_run
    from .scenarios import Scenario

    replay = load_parity_adapter()  # 윤선님 재생기 없이는 실제 앱을 검사하지 않는다
    if args.run_id is not None:
        validate_run_id(args.run_id)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,39}", args.name):
        raise PremortemError("INPUT_INVALID", f"--name은 소문자·숫자·-_. 만 쓸 수 있음: {args.name!r}")
    app_dir, record = Path(args.app), Path(args.record)
    noise = Path(args.noise) if args.noise else record.with_name(record.stem + ".noise.json")
    for option, path in (("--app", app_dir), ("--record", record), ("--noise", noise)):
        if not path.exists():
            raise PremortemError("INPUT_INVALID", f"{option} 경로가 없음: {path}")
    try:
        after = tuple(int(part) for part in args.after.split(",") if part.strip()) if args.after else ()
    except ValueError:
        raise PremortemError("INPUT_INVALID", f"--after는 '10' 또는 '3,7' 같은 요청 번호: {args.after!r}") from None
    scenario = Scenario(args.name, f"{args.name} (parity 기록)", app_dir, record, noise, args.port,
                        args.health_path, args.health_timeout, after, CORE_CONDITIONS, (), {})
    settings = Settings()
    command_runner = SubprocessRunner()
    docker = DockerDriver(command_runner, settings)
    docker.require_daemon()
    result = execute_run(scenario, app_dir, "pretest", None, settings, docker, replay, command_runner,
                         Path(args.run_root) if args.run_root else None, run_id=args.run_id)
    write_report(result.run_dir)
    write_handoff(result.run_dir)
    overall = result.env_report["overall_status"]
    if args.json:
        _print_json({"run_id": result.run_id, "run_dir": str(result.run_dir), "overall_status": overall,
                     "conditions": [{"name": c["name"], "status": c["status"], "matched": c["matched_count"],
                                     "expected": c["expected_count"]} for c in result.env_report["conditions"]],
                     "cleanup_failures": result.cleanup_failures})
    else:
        print("\n".join(summary_lines(result.env_report)))
        print(f"결과: {result.run_dir}")
    if result.cleanup_failures:
        print("정리하지 못한 자기 컨테이너: " + ", ".join(c[:12] for c in result.cleanup_failures)
              + " → docker rm --force <ID>로 직접 지워 주세요", file=sys.stderr)
        return EXIT_ERROR
    return {"passed": EXIT_OK, "failed": EXIT_FAILED, "inconclusive": EXIT_INCOMPLETE}.get(overall, EXIT_ERROR)


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

    run = sub.add_parser("run", help="실제 앱 검사: 윤선님 parity 재생기로 none·restart·replace 실행")
    run.add_argument("--app", required=True, help="앱 소스 폴더 (Dockerfile 포함)")
    run.add_argument("--record", required=True, help="parity 기록 파일 (session.jsonl)")
    run.add_argument("--noise", help="parity 노이즈 파일 (기본: <기록이름>.noise.json)")
    run.add_argument("--name", default="app", help="이미지 태그와 run_id 앞부분 (소문자, 숫자, -_.)")
    run.add_argument("--port", type=int, default=8080, help="컨테이너 안 앱 포트 (기본 8080)")
    run.add_argument("--health-path", default="/healthz", help="준비 확인 경로 (기본 /healthz)")
    run.add_argument("--health-timeout", type=float, default=30.0, help="준비 확인 최대 초 (기본 30)")
    run.add_argument("--after", help="조건을 넣을 요청 번호, 쉼표로 구분 (예: 10). 없으면 가운데 한 번")
    run.add_argument("--run-id", help="파이프라인이 만든 run_id. 없으면 새로 만든다")
    run.add_argument("--run-root", help="실행 결과를 둘 폴더 (기본 premortem/.runs)")
    run.add_argument("--json", action="store_true")
    run.set_defaults(handler=_cmd_run)

    self_test = sub.add_parser("self-test", help="단위 테스트 실행. --docker면 실제 Docker 시험 포함")
    self_test.add_argument("--docker", action="store_true")
    self_test.add_argument("-v", "--verbose", action="store_true")
    self_test.set_defaults(handler=_cmd_self_test)

    build = sub.add_parser("build", help="커밋된 앱을 레지스트리에 업로드하고 index digest 확인")
    build.add_argument("--app", required=True, help="Dockerfile이 있는 Git 앱 폴더")
    build.add_argument("--image-repo", required=True, help="태그 없는 registry/이미지 경로")
    build.add_argument("--run-id", required=True)
    build.add_argument("--out-dir", required=True, help="새 빌드 결과 폴더 (앱 폴더 밖)")
    build.add_argument("--platforms", default="linux/amd64,linux/arm64")
    build.add_argument("--builder", help="사용할 buildx builder 이름")
    build.add_argument("--timeout", type=int, default=900, help="빌드·pull 제한 시간(초)")
    build.add_argument("--json", action="store_true")
    build.set_defaults(handler=_cmd_build)

    test_build = sub.add_parser('test-build', help='빌드한 같은 이미지로 세 조건 검사와 원본 인계 파일 생성')
    test_build.add_argument('--build-manifest', required=True)
    test_build.add_argument('--record', required=True)
    test_build.add_argument('--noise', required=True)
    test_build.add_argument('--name', required=True)
    test_build.add_argument('--out-dir', required=True)
    test_build.add_argument('--run-id', help='빌드 기록과 대조할 파이프라인 ID')
    test_build.add_argument('--source-revision', help='빌드 기록과 대조할 앱 커밋 전체 SHA')
    test_build.add_argument('--digest', help='빌드 기록과 대조할 index digest')
    test_build.add_argument('--port', type=int, default=8080)
    test_build.add_argument('--health-path', default='/healthz')
    test_build.add_argument('--health-timeout', type=float, default=30)
    test_build.add_argument('--after')
    test_build.add_argument('--json', action='store_true')
    test_build.set_defaults(handler=_cmd_test_build)

    preview = sub.add_parser('policy-preview', help='parity 원본을 정책 변환기와 결정기에 전달 (서명·배포 없음)')
    preview.add_argument('--test-dir', required=True)
    preview.add_argument('--out-dir', required=True)
    preview.add_argument('--policy-root')
    preview.add_argument('--json', action='store_true')
    preview.set_defaults(handler=_cmd_policy_preview)

    backend = sub.add_parser('backend-test', help='Backend 호출용 테스트 단계 (요청 JSON → 정책 입력 JSON)')
    backend.add_argument('--request', required=True)
    backend.add_argument('--out-dir', required=True)
    backend.add_argument('--policy-root')
    backend.add_argument('--json', action='store_true', default=True)
    backend.set_defaults(handler=_cmd_backend_test)

    repair = sub.add_parser('repair-build', help='AI 수정안을 복사본에만 적용하고 같은 기록으로 재검증')
    repair.add_argument('--build-manifest', required=True)
    repair.add_argument('--record', required=True)
    repair.add_argument('--noise', required=True)
    repair.add_argument('--name', required=True)
    repair.add_argument('--out-dir', required=True)
    repair.add_argument('--allow-edit', action='append', required=True)
    repair.add_argument('--ai', choices=('live', 'json-file', 'recorded'), required=True)
    repair.add_argument('--analysis-file')
    repair.add_argument('--plan')
    repair.add_argument('--port', type=int, default=8080)
    repair.add_argument('--health-path', default='/healthz')
    repair.add_argument('--health-timeout', type=float, default=30)
    repair.add_argument('--after')
    repair.add_argument('--json', action='store_true')
    repair.set_defaults(handler=_cmd_repair_build)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows 기본(cp949)과 상관없이 --json 출력을 UTF-8로 고정
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
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
