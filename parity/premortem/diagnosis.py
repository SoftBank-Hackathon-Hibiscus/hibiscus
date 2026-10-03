"""Read-only diagnosis of a completed registry replay; no patch or deployment action.

python -m premortem.diagnosis --bundle TEST_DIR --source app.py --out NEW_DIR [--live]
"""

import argparse
import ast
import io
import json
import sys
import tokenize
from pathlib import Path

from .ai.anthropic_provider import AnthropicMessagesProvider
from .ai.provider import AnalysisResult
from .ai.schema_subset import api_subset
from .errors import PremortemError
from .evidence import utc_now
from .jsonio import load_json, loads_strict, write_json_atomic, write_text_atomic
from .paths import resolve_inside
from .redact import redact
from .snapshot import sha256_bytes, verify_source_tree

PROMPT_PATH = Path(__file__).with_name("ai") / "diagnosis.txt"
TEMPLATE_PATH = Path(__file__).with_name("diagnosis.html")


def obj(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def array(items, **kwargs):
    return {"type": "array", "items": items, **kwargs}


TEXT = {"type": "string", "minLength": 1, "maxLength": 1200}
IDS = array({"type": "string"}, uniqueItems=True)
OUTPUT_SCHEMA = obj({
    "findings": array(obj({
        "id": {"type": "string", "minLength": 1, "maxLength": 60},
        "title": {"type": "string", "minLength": 1, "maxLength": 60},
        "observed": TEXT,
        "hypothesis": TEXT,
        "mismatch_ids": array({"type": "string"}, minItems=1, uniqueItems=True),
        "fact_ids": IDS,
        "source_locations": array(obj({
            "path": {"type": "string"},
            "line_start": {"type": "integer", "minimum": 1},
            "line_end": {"type": "integer", "minimum": 1},
        }), maxItems=6),
        "scope": {"type": "string", "enum": ["code", "configuration", "code_and_infrastructure", "unknown"]},
        "next_action": TEXT,
        "verification": TEXT,
        "limit": TEXT,
    }), maxItems=10),
    "unexplained_mismatch_ids": IDS,
})


def require(ok, message):
    if not ok:
        raise PremortemError("DIAGNOSIS_INVALID", message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def sanitized(value):
    """Redact string values before JSON escaping can hide credential syntax."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [sanitized(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitized(item) for key, item in value.items()}
    return value


def hide_python_notes(text):
    """Hide comments/docstrings, preserving original lines and all executable strings."""
    lines = text.splitlines(keepends=True)
    spans = []
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT:
            spans.append((token.start, token.end))
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr):
                value = node.body[0].value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    # AST columns are UTF-8 byte offsets; tokenize columns are characters.
                    start = len(lines[value.lineno - 1].encode()[:value.col_offset].decode())
                    end = len(lines[value.end_lineno - 1].encode()[:value.end_col_offset].decode())
                    spans.append(((value.lineno, start), (value.end_lineno, end)))
    for (first, start), (last, end) in spans:
        for row in range(first, last + 1):
            line = lines[row - 1]
            low, high = (start if row == first else 0), (end if row == last else len(line))
            lines[row - 1] = line[:low] + "".join(c if c in "\r\n" else " " for c in line[low:high]) + line[high:]
    return "".join(lines)


def build_input(bundle, source_paths):
    bundle = Path(bundle)
    execution = load_json(resolve_inside(bundle, "execution_manifest.json"))
    require(execution.get("status") == "completed" and not execution.get("cleanup_failures"), "완료되고 정리된 실행 기록이 필요합니다")
    required = {"result.json", "build_manifest.json", "verified.diagnostics.json"}
    artifacts = execution.get("artifacts", {})
    require(required <= artifacts.keys(), "실행 기록에 필수 산출물 해시가 없습니다")
    verified = {}
    for name, digest in artifacts.items():
        content = resolve_inside(bundle, name).read_bytes()
        require(sha256_bytes(content) == digest, "실행 산출물 해시 불일치")
        if name in required:
            # Parse exactly the bytes that passed the hash check, never reopen the file.
            verified[name] = loads_strict(content.decode("utf-8"))
    build = verified["build_manifest.json"]
    result = verified["result.json"]
    diagnostic = verified["verified.diagnostics.json"]
    source_hashes = verify_source_tree(bundle / "source", build["source"]["tree_sha256"])
    require(execution["run_id"] == build["run_id"] == diagnostic["run_id"], "실행 ID 불일치")
    require(execution["source_revision"] == build["source"]["commit"] == diagnostic["source_revision"], "소스 커밋 불일치")
    commit = result.get("commit", "")
    require(len(commit) >= 7 and execution["source_revision"].startswith(commit), "결과의 소스 커밋 불일치")
    require(execution["digest"] == build["image"]["registry_digest"] == diagnostic["registry_digest"], "이미지 digest 불일치")
    require(execution["local_image_id"] == build["image"]["local_image_id"] == diagnostic["local_image_id"] == result["image"], "실행 이미지 불일치")
    require(diagnostic.get("status") == "completed" and diagnostic.get("error") is None
            and diagnostic.get("target_binding_verified") is True and diagnostic.get("baseline_unchanged") is True
            and diagnostic.get("result_sha256") == artifacts["result.json"], "완료된 실행과 결과의 연결을 확인할 수 없습니다")
    require(build["image"].get("source_build_link_verified") is True
            and build["image"].get("registry_link_verified") is True, "소스와 이미지 연결이 확인되지 않았습니다")
    conditions = result["replay"]
    require(len({c["condition"] for c in conditions}) == len(conditions), "중복 실행 조건")
    executed = {c["condition"]: c["executed"] for c in diagnostic["conditions"]}
    require(set(executed) == {c["condition"] for c in conditions}, "실행 기록과 결과의 조건 목록 불일치")
    mismatches = []
    for m in result["mismatches"]:
        mismatches.append({"id": f"{m['condition']}:{m['index']}", **m})
    require(len({m["id"] for m in mismatches}) == len(mismatches), "중복 불일치")
    for c in conditions:
        require(c["condition"] in ("none", "restart", "replace"), "지원하지 않는 실행 조건")
        require(type(c["total"]) is int and type(c["matched"]) is int
                and 0 <= c["matched"] <= c["total"] == executed.get(c["condition"]), "실행 횟수 불일치")
        affected = [m for m in mismatches if m["condition"] == c["condition"]]
        require(len(affected) == c["total"] - c["matched"], "불일치 목록과 집계 불일치")
        require(all(type(m["index"]) is int and 1 <= m["index"] <= c["total"] for m in affected), "잘못된 요청 번호")
    require(all(m["condition"] in executed for m in mismatches), "알 수 없는 실행 조건")
    require(result.get("passed") is (not mismatches) and execution.get("passed") is result["passed"], "불일치 목록과 통과 여부 불일치")
    sources = []
    require(bool(source_paths) and len(set(source_paths)) == len(source_paths), "분석할 Python 소스를 명시하세요")
    for path in source_paths:
        require(path.endswith(".py"), "현재 진단 입력은 Python 소스만 지원합니다")
        source = resolve_inside(bundle / "source", path)
        content = source.read_bytes()
        digest = sha256_bytes(content)
        require(digest == source_hashes.get(path), "소스 검사 후 분석할 파일이 바뀌었습니다")
        # Keep decoding, sanitization, and the recorded hash bound to this byte buffer.
        # Preserve read_text's universal-newline behavior for existing recorded inputs.
        text = content.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
        require(len(text) <= 60000, "소스가 분석 크기 한도를 넘었습니다")
        hidden = hide_python_notes(text)
        source_text = redact(hidden)
        require(len(hidden.splitlines()) == len(source_text.splitlines()), "비밀값 제거로 줄 번호가 바뀌어 분석을 중단합니다")
        sources.append({"path": path, "sha256": digest, "line_start": 1, "content": source_text})
    return {
        "format": "hibiscus-diagnosis-input-v1", "run_id": execution["run_id"],
        "source_revision": execution["source_revision"], "source_tree_sha256": build["source"]["tree_sha256"],
        "result_sha256": artifacts["result.json"], "image_digest": execution["digest"],
        "recorded_at": build["created_at"], "conditions": conditions,
        "mismatches": sanitized(mismatches),
        "facts": [{"id": f"fact:{i + 1}", **sanitized(f)} for i, f in enumerate(result["facts"])],
        "sources": sources, "notes_hidden": True, "policy_hints_included": False,
        "condition_semantics": {"none": "Same requests without lifecycle interruption.",
            "restart": "Restart the same container after the specified request indices.",
            "replace": "Remove the container and create a fresh container from the same image after the specified request indices."},
        "interrupt_after": execution["settings"]["after"],
    }


def check_output(output, payload):
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        raise PremortemError("SCHEMA_UNCHECKED", "jsonschema 설치가 필요합니다") from None
    require(not list(Draft202012Validator(OUTPUT_SCHEMA).iter_errors(output)), "AI 응답 형식이 맞지 않습니다")
    known = {m["id"] for m in payload["mismatches"]}
    facts = {f["id"] for f in payload["facts"]}
    sources = {s["path"]: s for s in payload["sources"]}
    ids, explained = set(), set()
    for finding in output["findings"]:
        require(finding["id"] not in ids, "중복 원인 ID")
        ids.add(finding["id"])
        require(set(finding["mismatch_ids"]) <= known, "입력에 없는 불일치를 인용했습니다")
        require(set(finding["fact_ids"]) <= facts, "입력에 없는 관측 근거를 인용했습니다")
        explained.update(finding["mismatch_ids"])
        for loc in finding["source_locations"]:
            require(loc["path"] in sources, "입력에 없는 소스를 인용했습니다")
            source = sources[loc["path"]]["content"].splitlines()
            require(1 <= loc["line_start"] <= loc["line_end"] <= len(source), "입력에 없는 줄을 인용했습니다")
            require(any(line.strip() for line in source[loc["line_start"] - 1:loc["line_end"]]), "가린 주석만 인용했습니다")
    unknown = set(output["unexplained_mismatch_ids"])
    require(not (unknown & explained) and unknown | explained == known, "설명된 불일치와 미확인 불일치를 모두 구분해야 합니다")
    # Reference integrity is checked here. Causal correctness still needs review/replay.


def analyze(payload, provider, rejected_path=None):
    prompt = PROMPT_PATH.read_text(encoding="utf-8")
    result = provider.analyze(prompt, canonical(payload), api_subset(OUTPUT_SCHEMA))
    if result.status == "succeeded":
        try:
            check_output(result.output, payload)
        except PremortemError as error:
            if rejected_path is not None:
                write_json_atomic(rejected_path, {"reason": error.message, "output": result.output})
            result = AnalysisResult(result.provider, result.model, "invalid", None,
                                    duration_ms=result.duration_ms, usage=result.usage,
                                    request_id=result.request_id, error_code=error.code)
    return {
        "format": "hibiscus-diagnosis-record-v1", "run_id": payload["run_id"],
        "created_at": utc_now(), "provider": result.provider, "model": result.model,
        "status": result.status, "output": result.output if result.status == "succeeded" else None,
        "duration_ms": result.duration_ms, "usage": result.usage, "error_code": result.error_code,
        "request_id": result.request_id, "input_sha256": sha256_bytes(canonical(payload).encode()),
        "prompt_sha256": sha256_bytes(prompt.encode()), "causal_review": "not_automatically_verified",
    }


def render_report(payload, record):
    data = canonical({"input": payload, "analysis": record})
    # A literal closing script tag must never escape this JSON script element.
    data = data.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return TEMPLATE_PATH.read_text(encoding="utf-8").replace("__REPORT_DATA__", data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--out", required=True, type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--live", action="store_true", help="明示したソースと記録を LLM に送信 / 실제 LLM 분석")
    modes.add_argument("--recorded", type=Path, help="같은 입력에 대한 이전 실제 분석 사용 (호출 없음)")
    args = parser.parse_args(argv)
    try:
        args.bundle = args.bundle.resolve()
        args.out = args.out.resolve()
        require(not args.out.is_relative_to(args.bundle), "진단 출력은 원본 실행 폴더 밖에 저장해야 합니다")
        payload = build_input(args.bundle, args.source)
        args.out.mkdir(parents=True, exist_ok=False)
        write_json_atomic(args.out / "diagnosis_input.json", payload)
        record = None
        if args.live:
            record = analyze(payload, AnthropicMessagesProvider.from_environment(timeout_sec=180),
                             args.out / "diagnosis_rejected.json")
        elif args.recorded:
            record = load_json(args.recorded)
            require(record.get("format") == "hibiscus-diagnosis-record-v1"
                    and record.get("provider") == "anthropic_messages"
                    and record.get("status") == "succeeded"
                    and record.get("run_id") == payload["run_id"]
                    and record.get("input_sha256") == sha256_bytes(canonical(payload).encode()), "분석 기록과 현재 입력이 다릅니다")
            check_output(record["output"], payload)
        if record:
            write_json_atomic(args.out / "diagnosis.json", record)
        write_text_atomic(args.out / "index.html", render_report(payload, record))
        print(canonical({"report": str(args.out / "index.html"), "analysis": record["status"] if record else "not_run"}))
        return 0 if record is None or record["status"] == "succeeded" else 1
    except (PremortemError, OSError, KeyError, TypeError, ValueError, SyntaxError, tokenize.TokenError) as error:
        # Do not echo source/response contents or credentials on failure.
        code = error.code if isinstance(error, PremortemError) else type(error).__name__
        print(f"진단 중단: {code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
