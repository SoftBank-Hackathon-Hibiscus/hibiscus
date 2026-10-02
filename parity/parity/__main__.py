"""CLI: python -m parity <명령> ...

  record   기록 프록시를 띄워 요청/응답을 JSONL 로 남긴다 (비밀값은 가려서)   (1단계)
  noise    초기 상태에서 여러 번 재생해 매번 달라지는 필드를 찾는다            (2단계)
  facts    컨테이너 안에 남은 상태(sqlite, 업로드 등)를 나열한다
  test     조건별로 컨테이너를 재생성·재시작하며 재생·비교 → result.json        (3단계)
  verify   Docker 조작 없이 요청만 재생·비교 → 결과 JSON (배포 후 http/https 확인용)
  summary  결과 JSON 을 한 줄로 요약한다

종료 코드: 0 = 통과(또는 정상 종료), 1 = 불일치 있음(test/verify), 2 = 실행 오류
"""
import argparse
import json
import os
import sys

from . import conditions as conditions_mod
from . import docker_ops, facts as facts_mod, noise as noise_mod
from .record import load_records, make_ssl_context, record, request_label
from .replay import replay
from .report import build_result, evaluate, git_commit, summary_lines

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def log(message):
    print(message, file=sys.stderr, flush=True)


def _health_url(args):
    return args.target.rstrip("/") + args.health_path


def _ensure_parent(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)


def _write_json(obj, path):
    _ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _load_records(path):
    records = load_records(path)
    if not records:
        raise ValueError(f"기록이 비어 있습니다: {path}")
    return records


def _load_noise(args):
    path = args.noise or noise_mod.default_noise_path(args.record)
    if os.path.exists(path):
        log(f"[{args.cmd}] 노이즈 적용 규칙 사용: {path}")
        return noise_mod.load(path, log=log)
    log(f"[{args.cmd}] 경고: 노이즈 파일 {path} 이 없어 모든 필드를 비교합니다 (먼저 noise 명령 실행 권장)")
    return {}


def _reset_container(args, ssl_context):
    """컨테이너를 지우고 다시 만들어 초기 상태로 되돌린 뒤 헬스체크가 통과할 때까지 기다린다."""
    docker_ops.recreate(args.container)
    docker_ops.wait_healthy(_health_url(args), args.health_timeout, ssl_context=ssl_context)


def _finish(result_json, out):
    _write_json(result_json, out)
    log(f"[{result_json['stage']}] 결과 저장: {out}")
    for line in summary_lines(result_json):
        print(line)
    return 0 if result_json["passed"] else 1


def cmd_record(args):
    host, _, port = args.listen.rpartition(":")
    if not host or not port.isdigit():
        raise ValueError(f"--listen 은 호스트:포트 형식이어야 합니다: {args.listen!r}")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    ssl_context = make_ssl_context(args.target, args.cafile)
    if args.health_path:
        docker_ops.wait_healthy(_health_url(args), args.health_timeout, ssl_context=ssl_context)
    _ensure_parent(args.out)
    return record(args.target, args.out, host, int(port), command or None, ssl_context)


def cmd_noise(args):
    records = _load_records(args.record)
    ssl_context = make_ssl_context(args.target, args.cafile)
    result = noise_mod.detect(records, args.target, runs=args.runs,
                              prepare=lambda: _reset_container(args, ssl_context), log=log,
                              extra_headers=args.header, ssl_context=ssl_context)
    out = args.out or noise_mod.default_noise_path(args.record)
    noise_mod.save(result, out)
    applied = [c for c in result["candidates"] if c["decision"] == "applied"]
    rejected = [c for c in result["candidates"] if c["decision"] == "rejected"]
    log(f"[noise] 후보 {len(result['candidates'])}개 → 적용 {len(applied)}개, 거부 {len(rejected)}개 → {out}")
    for c in rejected:
        log(f"[noise]   거부: #{c['index']} {c['request']} {c['field']} ({c['reason']}) — 비교에서 빼지 않습니다")
    return 0


def cmd_facts(args):
    print(json.dumps(facts_mod.collect(args.container), ensure_ascii=False, indent=2))
    return 0


def cmd_test(args):
    from .execution import run_test
    return run_test(args, log=log)


def cmd_verify(args):
    records = _load_records(args.record)
    writes = [request_label(r) for r in records if r["request"]["method"].upper() not in SAFE_METHODS]
    if writes and not args.allow_writes:
        shown = ", ".join(writes[:5]) + (" …" if len(writes) > 5 else "")
        raise ValueError(f"기록에 쓰기 요청 {len(writes)}개가 있습니다 ({shown}). verify 는 대상의 상태를 "
                         f"초기화하지 않으므로 실제 데이터가 바뀝니다. 의도한 것이면 --allow-writes 를 붙이세요")
    noise_by_index = _load_noise(args)
    ssl_context = make_ssl_context(args.target, args.cafile)
    log(f"[verify] {args.target} 에 요청 {len(records)}개 재생 (Docker 조작·상태 초기화 없음)")
    result = replay(records, args.target, extra_headers=args.header, ssl_context=ssl_context, log=log)
    entry, mismatches = evaluate("none", records, result, noise_by_index, facts=[])
    log(f"[verify] {entry['matched']}/{entry['total']} 일치")
    # 원격 대상이 어떤 코드/이미지인지 이 도구는 확인할 수 없다 → 근거로 오인되지 않게 둘 다 unknown.
    return _finish(build_result("unknown", [], [entry], mismatches, commit="unknown", stage="verify"),
                   args.out)


def cmd_summary(args):
    with open(args.result, encoding="utf-8") as f:
        result = json.load(f)
    for line in summary_lines(result):
        print(line)
    for m in result["mismatches"]:
        print(f"  - [{m['condition']}] #{m['index']} {m['request']}: "
              f"기대 {m['expected']} / 실제 {m['actual']} (관련 사실: {m['related_fact'] or '없음'})")
    return 0


def parse_header(text):
    name, sep, value = text.partition(":")
    if not sep or not name.strip():
        raise argparse.ArgumentTypeError(f"'이름: 값' 형식이어야 합니다: {text!r}")
    return [name.strip(), value.strip()]


def _add_target_options(p, container=True, health=True, inject=True):
    p.add_argument("--target", required=True, help="대상 서버 URL (예: http://localhost:8080, https://...)")
    p.add_argument("--cafile", help="https 대상의 사설 CA 인증서(PEM). 인증서 검증은 항상 켜져 있음")
    if container:
        p.add_argument("--container", required=True, help="대상 컨테이너 이름 (재생성·재시작에 사용)")
    if health:
        p.add_argument("--health-path", default="/healthz", help="헬스체크 경로 (기본 /healthz)")
        p.add_argument("--health-timeout", type=float, default=30.0, help="헬스체크 대기 최대 초 (기본 30)")
    if inject:
        p.add_argument("--header", type=parse_header, action="append", default=[],
                       help="재생 요청에 넣을 헤더 'Name: value' (여러 번 가능). 기록에서 가려진 인증 헤더 대체용")


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m parity", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("record", help="기록 프록시 실행")
    _add_target_options(p, container=False, inject=False)
    p.add_argument("--out", required=True, help="기록 파일 경로 (.jsonl)")
    p.add_argument("--listen", default="127.0.0.1:8081", help="프록시가 받을 주소 (기본 127.0.0.1:8081)")
    p.add_argument("command", nargs=argparse.REMAINDER,
                   help="-- 뒤에 명령을 주면 그 명령이 끝날 때까지만 기록")
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("noise", help="노이즈 필드 탐지")
    p.add_argument("--record", required=True)
    _add_target_options(p)
    p.add_argument("--runs", type=int, default=2, help="재생 반복 횟수, 2 이상 (기본 2)")
    p.add_argument("--out", help="기본값: <기록파일이름>.noise.json")
    p.set_defaults(func=cmd_noise)

    p = sub.add_parser("facts", help="컨테이너 상태 사실 나열")
    p.add_argument("--container", required=True)
    p.set_defaults(func=cmd_facts)

    p = sub.add_parser("test", help="조건별 재생 → result.json")
    p.add_argument("--record", required=True)
    _add_target_options(p)
    p.add_argument("--conditions", default="none,restart,replace",
                   help=f"쉼표로 구분 (기본: %(default)s; 지원: {', '.join(conditions_mod.SUPPORTED)})")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--restart-after", help="이 요청 번호들 뒤에 재시작 (예: 3,7)")
    group.add_argument("--restart-every", action="store_true", help="모든 요청 사이에 재시작")
    p.add_argument("--noise", help="노이즈 파일 (기본값: <기록파일이름>.noise.json)")
    p.add_argument("--out", default="result.json")
    p.add_argument("--expected-image-id", help="검사할 컨테이너의 로컬 이미지 ID (registry digest가 아님)")
    p.set_defaults(func=cmd_test)

    p = sub.add_parser("verify", help="Docker 조작 없이 요청만 재생 (배포 후 확인)")
    p.add_argument("--record", required=True)
    _add_target_options(p, container=False, health=False)
    p.add_argument("--noise", help="노이즈 파일 (기본값: <기록파일이름>.noise.json)")
    p.add_argument("--allow-writes", action="store_true",
                   help="기록에 POST/PUT/PATCH/DELETE 가 있어도 재생 (대상 데이터가 실제로 바뀜)")
    p.add_argument("--out", default="verify.json")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("summary", help="결과 JSON 요약 출력")
    p.add_argument("result")
    p.set_defaults(func=cmd_summary)
    return parser


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (docker_ops.DockerError, TimeoutError, ValueError, OSError) as e:
        log(f"오류: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
