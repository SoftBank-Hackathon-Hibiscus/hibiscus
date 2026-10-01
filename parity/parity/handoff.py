"""Proposed raw-result handoff envelope; this is NOT the team's Policy schema.

Run metadata is explicitly supplied by the caller. This module neither verifies
the running image nor infers application provenance from parity's git checkout.
The policy owner remains responsible for normalizing facts and condition totals.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile


FORMAT = "parity-handoff-v1-proposal"
RUN_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")
REVISION = re.compile(r"[0-9a-f]{7,40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def _require(test, message):
    if not test:
        raise ValueError(message)


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _integer(value, minimum=0):
    return type(value) is int and value >= minimum


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def sha256(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical_result_bytes(result):
    """Fingerprint convention: sorted keys, compact JSON, UTF-8, no NaN."""
    return json.dumps(result, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def validate_metadata(run_id, app, source_revision, digest):
    for key, value, pattern in (("run_id", run_id, RUN_ID),
                                ("source_revision", source_revision, REVISION),
                                ("digest", digest, DIGEST)):
        _require(isinstance(value, str) and pattern.fullmatch(value) is not None,
                 f"invalid {key}; use an explicit caller-supplied value (see --help)")
    _require(_text(app), "app must be a nonempty string")
    return {"run_id": run_id, "app": app, "source_revision": source_revision, "digest": digest}


def validate_result(result):
    """Check reporting consistency without interpreting policy or rewriting data."""
    _require(isinstance(result, dict), "result must be an object")
    _require(result.get("stage") == "test", "handoff accepts pre-deploy stage 'test' only, not verify")
    _require(type(result.get("passed")) is bool, "passed must be boolean")
    for key in ("commit", "image"):
        _require(_text(result.get(key)), f"{key} must be a nonempty string")
    _require(isinstance(result.get("facts"), list), "raw facts must remain an array")
    for fact in result["facts"]:
        _require(isinstance(fact, dict), "each fact must be an object")
        for key in ("kind", "path", "storage", "evidence"):
            _require(_text(fact.get(key)), f"fact.{key} must be a nonempty string")

    entries = result.get("replay")
    _require(isinstance(entries, list) and bool(entries), "replay must be a nonempty array")
    conditions = {}
    for entry in entries:
        _require(isinstance(entry, dict), "each replay entry must be an object")
        name = entry.get("condition")
        _require(_text(name), "replay.condition must be a nonempty string")
        _require(name not in conditions, f"duplicate condition: {name}")
        _require(_integer(entry.get("total"), 1), f"{name}.total must be a positive integer")
        _require(_integer(entry.get("matched")) and entry["matched"] <= entry["total"],
                 f"{name}.matched must be an integer between zero and total")
        if "error" in entry:
            _require(_text(entry["error"]), f"{name}.error must be a nonempty string")
        conditions[name] = entry

    mismatches = result.get("mismatches")
    _require(isinstance(mismatches, list), "mismatches must be an array")
    counts = dict.fromkeys(conditions, 0)
    seen = set()
    for mismatch in mismatches:
        _require(isinstance(mismatch, dict), "each mismatch must be an object")
        name, index = mismatch.get("condition"), mismatch.get("index")
        _require(isinstance(name, str) and name in conditions, "mismatch refers to unknown condition")
        _require(_integer(index, 1) and index <= conditions[name]["total"],
                 "mismatch.index must be between 1 and its condition total")
        _require((name, index) not in seen, f"duplicate mismatch: {name} request {index}")
        seen.add((name, index))
        for key in ("request", "expected", "actual"):
            _require(isinstance(mismatch.get(key), str), f"mismatch.{key} must be a string")
        _require("related_fact" in mismatch and
                 (mismatch["related_fact"] is None or isinstance(mismatch["related_fact"], str)),
                 "mismatch.related_fact must be a string or null")
        counts[name] += 1

    for name, entry in conditions.items():
        unmatched = entry["total"] - entry["matched"]
        # Aborted requests may never have been sent and have no mismatch object.
        _require(counts[name] <= unmatched, f"{name}: more mismatches than unmatched requests")
        if "error" not in entry:
            _require(counts[name] == unmatched, f"{name}: completed replay mismatch count is inconsistent")
    expected_passed = all(e["matched"] == e["total"] and "error" not in e for e in entries) and not mismatches
    _require(result["passed"] == expected_passed, "passed conflicts with replay outcomes/errors/mismatches")


def build_envelope(result_bytes, result_name, metadata):
    """Read a single immutable input snapshot; keep all raw result fields."""
    metadata = validate_metadata(**metadata)
    result = json.loads(result_bytes.decode("utf-8-sig"), object_pairs_hook=_unique_object,
                        parse_constant=_invalid_constant)
    validate_result(result)
    for key, value in metadata.items():
        if key == "source_revision" and result.get(key) == "unknown":
            continue
        if key in result:
            _require(result[key] == value, f"provided {key} conflicts with result.{key}")
    return {
        "format": FORMAT,
        "metadata": metadata,
        "provenance": {
            "status": "caller_asserted",
            "image_verified": False,
            "notice": "Metadata was supplied by the caller; image/source provenance was not independently verified. "
                      "This proposed envelope is not the approved shared Policy contract or a signature.",
        },
        "result_artifact": {"name": Path(result_name).name, "sha256": sha256(result_bytes),
                            "byte_length": len(result_bytes)},
        "result_sha256": sha256(canonical_result_bytes(result)),
        "result": copy.deepcopy(result),
    }


def write_handoff(result_path, out_path, **metadata):
    source, target = Path(result_path), Path(out_path)
    _require(source.resolve() != target.resolve(), "output must not replace input result")
    if source.exists() and target.exists():
        _require(not os.path.samefile(source, target), "output must not alias input result")
    envelope = build_envelope(source.read_bytes(), source.name, metadata)
    payload = (json.dumps(envelope, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".parity-handoff-", suffix=".tmp",
                                         dir=str(target.parent), delete=False) as tmp:
            temp_path = Path(tmp.name)
            tmp.write(payload)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return envelope


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", required=True, help="raw pre-deploy result.json (never modified)")
    parser.add_argument("--run-id", required=True, help="caller execution ID: letters/digits/._-, 1-64 characters")
    parser.add_argument("--app", required=True, help="application name supplied by caller")
    parser.add_argument("--source-revision", required=True, help="application commit SHA, lowercase hex 7-40; prefer full SHA")
    parser.add_argument("--digest", required=True, help="caller-supplied registry digest: sha256: plus 64 lowercase hex")
    parser.add_argument("--out", required=True, help="proposed handoff envelope, different from input")
    args = parser.parse_args(argv)
    try:
        envelope = write_handoff(args.result, args.out, run_id=args.run_id, app=args.app,
                                 source_revision=args.source_revision, digest=args.digest)
    except (ValueError, OSError) as exc:
        print(f"handoff error: {exc}", file=sys.stderr)
        return 2
    print(f"handoff snapshot written: {args.out}; test passed={str(envelope['result']['passed']).lower()}")
    print("Metadata is caller-asserted, not verified image provenance; Policy normalization is still required.",
          file=sys.stderr)
    return 0  # Packaging succeeded, not a test pass or permission to deploy.


if __name__ == "__main__":
    sys.exit(main())
