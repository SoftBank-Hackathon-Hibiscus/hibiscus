"""회의 합의 경로: 기존 test CLI의 실행 경계와 실패 결과 보존.

기본 result.json 계약은 유지한다. 로컬 이미지 ID와 기준 파일 해시는 별도
diagnostics 파일에 기록하며 registry digest / 앱 source revision으로 가장하지 않는다.
"""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

from . import conditions as conditions_mod, docker_ops, facts as facts_mod, noise as noise_mod
from .record import make_ssl_context
from .replay import replay
from .report import build_result, evaluate, git_commit, summary_lines


IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")


class ExecutionError(ValueError):
    pass


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".", suffix=".tmp",
                                         mode="w", encoding="utf-8", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, target)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _distinct(paths):
    for i, path in enumerate(paths):
        for other in paths[:i]:
            if path.resolve() == other.resolve() or (
                    path.exists() and other.exists() and os.path.samefile(path, other)):
                raise ValueError("기록·노이즈·결과·진단 파일은 서로 다른 파일이어야 합니다")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("중복 JSON 키가 있습니다")
        result[key] = value
    return result


def _json(text):
    def reject(value):
        raise ValueError("표준 JSON이 아닌 숫자입니다")
    return json.loads(text, object_pairs_hook=_pairs, parse_constant=reject)


def _part(part):
    if not isinstance(part, dict) or not isinstance(part.get("body"), str):
        raise ValueError("요청·응답 본문 형식이 잘못되었습니다")
    if part.get("body_encoding") not in ("utf8", "base64"):
        raise ValueError("요청·응답 인코딩이 잘못되었습니다")
    if part["body_encoding"] == "base64":
        base64.b64decode(part["body"], validate=True)
    headers = part.get("headers")
    if not isinstance(headers, list) or any(
            not isinstance(h, list) or len(h) != 2
            or any(not isinstance(v, str) or "\r" in v or "\n" in v for v in h)
            for h in headers):
        raise ValueError("요청·응답 헤더 형식이 잘못되었습니다")


class Baseline:
    def __init__(self, record_path, noise_path):
        self.paths = [Path(record_path), Path(noise_path)]
        self.raw = [self.paths[0].read_bytes(),
                    self.paths[1].read_bytes() if self.paths[1].exists() else None]
        self.records = [_json(line) for line in self.raw[0].decode("utf-8-sig").splitlines() if line.strip()]
        if not self.records:
            raise ValueError("기록이 비어 있습니다")
        for index, item in enumerate(self.records, 1):
            if not isinstance(item, dict) or type(item.get("index")) is not int or item["index"] != index:
                raise ValueError("요청 번호는 파일 순서대로 1부터 연속이어야 합니다")
            req, res = item.get("request"), item.get("response")
            _part(req)
            _part(res)
            path = req.get("path")
            if (not isinstance(req.get("method"), str) or not re.fullmatch(r"[A-Z]+", req["method"])
                    or not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
                    or "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path)
                    or type(res.get("status")) is not int or not 100 <= res["status"] <= 599):
                raise ValueError("요청 경로·메서드·상태코드 형식이 잘못되었습니다")
        self.noise = {}
        if self.raw[1] is not None:
            data = _json(self.raw[1].decode("utf-8-sig"))
            if not isinstance(data, dict) or not isinstance(data.get("rules"), list):
                raise ValueError("parity noise.rules 배열이 필요합니다")
            for rule in data["rules"]:
                if not isinstance(rule, dict):
                    raise ValueError("노이즈 규칙은 객체여야 합니다")
                index, fields = rule.get("index"), rule.get("fields")
                if (type(index) is not int or not 1 <= index <= len(self.records) or index in self.noise
                        or not isinstance(fields, list) or any(
                            not isinstance(f, str) or not f or f in ("body", "*") for f in fields)):
                    raise ValueError("노이즈 규칙 번호·필드가 잘못되었거나 본문 전체를 제외합니다")
                self.noise[index] = set(fields)

    def check(self):
        for path, original in zip(self.paths, self.raw):
            current = path.read_bytes() if path.exists() else None
            if current != original:
                raise ExecutionError("BASELINE_CHANGED")

    def hashes(self):
        return {name: hashlib.sha256(raw).hexdigest() if raw is not None else None
                for name, raw in zip(("record", "noise"), self.raw)}


def run_test(args, log=print):
    out = Path(args.out)
    diagnostics_path = out.with_name(out.stem + ".diagnostics.json")
    noise_path = Path(args.noise or noise_mod.default_noise_path(args.record))
    # 잘못된 출력 경로가 입력을 덮어쓰지 않도록, 결과 쓰기 전에 확인한다.
    _distinct([Path(args.record), noise_path, out, diagnostics_path])
    diagnostics = {"format": "parity-execution-v1", "status": "running", "phase": "input",
                   "container": args.container, "target": None, "local_image_id": None, "registry_digest": None,
                   "target_binding_verified": False,
                   "source_revision": None, "baseline_sha256": None, "baseline_unchanged": None,
                   "facts_collected": False, "conditions": [], "error": None}
    entries, mismatches, facts = [], [], []
    image, commit, baseline = "unknown", "unknown", None
    records, current_entry = [], None
    current_name = "setup"

    def publish():
        result = build_result(image, facts, entries, mismatches, commit=commit)
        if diagnostics["status"] != "completed":
            result["passed"] = False
        # 먼저 진단을 교체한다. 두 파일은 트랜잭션이 아니므로 소비자는 종료 코드도 확인한다.
        atomic_json(diagnostics_path, diagnostics)
        atomic_json(out, result)
        return result

    # 준비 중 중단돼도 지난 실행의 passed=true가 현재 결과로 남지 않게 한다.
    entries.append({"condition": "setup", "total": 0, "matched": 0, "error": "RUN_NOT_COMPLETED"})
    publish()
    try:
        names = [n.strip() for n in args.conditions.split(",") if n.strip()]
        if not names or len(names) != len(set(names)):
            raise ValueError("조건은 비어 있지 않고 중복되지 않아야 합니다")
        baseline = Baseline(args.record, noise_path)
        records = baseline.records
        diagnostics["baseline_sha256"] = baseline.hashes()
        entries[:] = [{"condition": n, "total": len(records), "matched": 0,
                       "error": "NOT_EXECUTED"} for n in names]
        publish()
        if not math.isfinite(args.health_timeout) or args.health_timeout <= 0:
            raise ValueError("health timeout은 양의 유한한 숫자여야 합니다")
        target = urlsplit(args.target)
        if (target.scheme not in ("http", "https") or not target.hostname or target.port == 0
                or target.username is not None or target.password is not None
                or target.query or target.fragment or target.path not in ("", "/")
                or any(character.isspace() for character in args.target)):
            raise ValueError("target은 인증 정보나 경로가 없는 http/https 주소여야 합니다")
        diagnostics["target"] = args.target
        restart_after = conditions_mod.parse_index_list(args.restart_after) if args.restart_after else None
        conditions = conditions_mod.build(names, args.container, args.target.rstrip("/") + args.health_path,
                                          restart_after=restart_after, restart_every=args.restart_every,
                                          health_timeout=args.health_timeout, log=log)
        fault_conditions = [condition for condition in conditions if condition.name != "none"]
        indices = [record["index"] for record in records]
        if fault_conditions and restart_after and any(index not in indices[:-1] for index in restart_after):
            raise ExecutionError("INVALID_FAULT_POSITION")
        if any(not condition.schedule(indices) for condition in fault_conditions):
            raise ExecutionError("NO_EFFECTIVE_FAULT")
        ssl_context = make_ssl_context(args.target, args.cafile)
        commit, _ = git_commit()
        diagnostics["phase"] = "identity"
        image = docker_ops.image_of(args.container)  # 기존 result.image 의미 유지: 이름 또는 참조
        pinned_image = docker_ops.image_id_of(args.container)
        if not isinstance(pinned_image, str) or not IMAGE_ID.fullmatch(pinned_image):
            raise ExecutionError("INVALID_LOCAL_IMAGE_ID")
        diagnostics["local_image_id"] = pinned_image
        expected = getattr(args, "expected_image_id", None)
        if expected is not None and (not IMAGE_ID.fullmatch(expected) or expected != pinned_image):
            raise ExecutionError("UNEXPECTED_LOCAL_IMAGE_ID")

        def check_image():
            if docker_ops.image_id_of(args.container) != pinned_image:
                raise ExecutionError("IMAGE_CHANGED")

        def check_between_requests(index, record, response):
            baseline.check()

        for current_name, cond, current_entry in zip(names, conditions, entries):
            diagnostics["phase"] = "prepare"
            baseline.check()
            check_image()
            docker_ops.recreate(args.container)
            check_image()
            docker_ops.wait_healthy(args.target.rstrip("/") + args.health_path,
                                    args.health_timeout, ssl_context=ssl_context)
            diagnostics["phase"] = "replay"
            replayed = replay(records, args.target, hooks=[cond], extra_headers=args.header,
                              ssl_context=ssl_context, log=log, on_response=check_between_requests)
            diagnostics["conditions"].append({"condition": current_name,
                                               "executed": sum(r is not None for r in replayed.responses)})
            # 판정에 필요한 부분 응답은 실행 오류가 있어도 보존한다.
            entry, found = evaluate(current_name, records, replayed, baseline.noise, facts)
            current_entry.clear()
            current_entry.update(entry)
            mismatches.extend(found)
            if replayed.error or any(r is None or r.error for r in replayed.responses):
                raise ExecutionError("REPLAY_INTERRUPTED")
            diagnostics["phase"] = "identity"
            check_image()
            diagnostics["phase"] = "baseline"
            baseline.check()
            if not diagnostics["facts_collected"]:
                diagnostics["phase"] = "facts"
                facts = facts_mod.collect(args.container)
                diagnostics["facts_collected"] = True
                # 처음 사실을 수집한 뒤 기존 규칙으로 근거 경로를 연결한다.
                from .report import related_fact
                for mismatch in mismatches:
                    path = records[mismatch["index"] - 1]["request"]["path"]
                    mismatch["related_fact"] = related_fact(path, facts)
            log(f"[test] {current_name}: {current_entry['matched']}/{len(records)}")
            publish()
        baseline.check()
        diagnostics.update(status="completed", phase="complete", baseline_unchanged=True)
        result = publish()
        for line in summary_lines(result):
            print(line)
        return 0 if result["passed"] else 1
    except (ValueError, OSError, docker_ops.DockerError) as error:
        if isinstance(error, ExecutionError):
            code = str(error)
        else:
            code = type(error).__name__
        safe_error = f"{diagnostics['phase']}: {code}"
        if current_entry is not None:
            current_entry["error"] = safe_error
        else:
            for entry in entries:
                entry["error"] = safe_error
        if baseline is not None:
            try:
                baseline.check()
                diagnostics["baseline_unchanged"] = True
            except OSError:
                diagnostics["baseline_unchanged"] = False
            except ExecutionError:
                diagnostics["baseline_unchanged"] = False
        diagnostics.update(status="error", error={"condition": current_name, "code": code,
                                                  "phase": diagnostics["phase"]})
        publish()
        log(f"[test] 실행 오류: {safe_error}. 진단 파일: {diagnostics_path}")
        return 2
