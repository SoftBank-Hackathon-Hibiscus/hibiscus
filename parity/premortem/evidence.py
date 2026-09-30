"""실행 증거 기록(evidence.jsonl).

요약과 원문은 저장 전에 가리고, 실행마다 저장량 상한을 둔다. 상한을 넘으면 조용히 버리지 않고
해당 조건을 표시해 판정을 inconclusive로 낮춘다. evidence_id는 같은 시나리오를 같은 순서로 실행하면
같은 값이 나온다(예: replace-http_mismatch-4). 녹화된 AI 응답을 다시 검증할 때 이 성질을 쓴다.
"""

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .jsonio import append_jsonl
from .redact import redact
from .validation import validate

MAX_SUMMARY_CHARS = 500
MAX_ARTIFACT_BYTES = 65_536


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class EvidenceLog:
    def __init__(self, run_id: str, run_dir: Path, max_bytes: int):
        self.run_id = run_id
        self.run_dir = Path(run_dir)
        self.max_bytes = max_bytes
        self.path = self.run_dir / "evidence.jsonl"
        self.path.touch()
        self.records: list = []
        self.stored_bytes = 0
        self.truncated_conditions: set = set()
        self._used: set = set()

    def _new_id(self, condition: str, kind: str, request_index: Optional[int]) -> str:
        base = f"{condition}-{kind}-{request_index if request_index is not None else 'na'}"
        evidence_id, number = base, 1
        while evidence_id in self._used:
            number += 1
            evidence_id = f"{base}-{number}"
        self._used.add(evidence_id)
        return evidence_id

    def add(self, condition: str, kind: str, summary: str, request_index: Optional[int] = None,
            artifact_text: Optional[str] = None) -> str:
        evidence_id = self._new_id(condition, kind, request_index)
        summary = redact(summary)
        if len(summary) > MAX_SUMMARY_CHARS:
            summary = summary[: MAX_SUMMARY_CHARS - 1] + "…"
        relative, digest = None, None
        if artifact_text is not None:
            data = redact(artifact_text).encode("utf-8")
            if len(data) > MAX_ARTIFACT_BYTES:
                data = data[-MAX_ARTIFACT_BYTES:]
                summary += " (원문은 뒷부분만 저장)"
            if self.stored_bytes + len(data) > self.max_bytes:
                self.truncated_conditions.add(condition)
                summary += " (실행별 증거 상한을 넘어 원문 저장 안 함)"
            else:
                relative = f"evidence/{evidence_id}.txt"
                target = self.run_dir / relative
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(data)
                digest = hashlib.sha256(data).hexdigest()
                self.stored_bytes += len(data)
        record = {
            "schema_version": "1.0",
            "evidence_id": evidence_id,
            "run_id": self.run_id,
            "condition": condition,
            "request_index": request_index,
            "kind": kind,
            "observed_at": utc_now(),
            "sanitized_summary": summary,
            "artifact_relative_path": relative,
            "artifact_sha256": digest,
        }
        validate("evidence-event", record)
        append_jsonl(self.path, record)
        self.records.append(record)
        return evidence_id

    def ids_for(self, condition: str) -> list:
        return [r["evidence_id"] for r in self.records if r["condition"] == condition]

    def by_id(self) -> dict:
        return {r["evidence_id"]: r for r in self.records}
