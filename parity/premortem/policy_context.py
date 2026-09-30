"""류진님 정책 결과(plan.json)의 requires를 AI 수정 목표로 읽는다 (IMPLEMENTATION_SPEC 12절).

- 형식은 류진님 개발일지 기준: requires = [{id, hint, rule_id, allowed_targets}]. 실제 contracts를 받으면 그 스키마로 다시 확인한다.
- allowed_targets는 "이 조건을 충족하면 갈 수 있는 후보 위치"다. 지금 배포해도 된다는 뜻이 아니며, 여러 조건을 합쳐 허가로 만들지 않는다.
- 모르는 id는 지우거나 해결했다고 하지 않고 사람이 할 일로 남긴다.
- plan의 run_id(와 둘 다 있을 때 digest)가 이번 실행과 다르면 섞인 입력이라 멈춘다.
"""

from pathlib import Path
from typing import Optional

from .errors import PremortemError
from .jsonio import load_json

KNOWN_REQUIREMENTS = {
    "fix_tests": "실제 불일치를 근거로 작은 앱 코드 수정 제안",
    "managed_db": "위치 제약을 지킨 채 DB 저장 방식 변경 제안. 실제 DB 생성·이관은 사람이 함",
    "object_storage": "파일 저장을 바깥으로 옮기는 변경 제안. 개인정보 제약을 넘는 저장소는 고르지 않음",
    "two_phase_migration": "자동 수정하지 않음. 호환 계획 검토 필요",
}


def load_requires(plan_path: Path, run_id: str, registry_digest: Optional[str]) -> list:
    plan = load_json(plan_path)
    if not isinstance(plan, dict):
        raise PremortemError("SCHEMA_INVALID", "plan.json은 객체여야 함")
    if plan.get("run_id") != run_id:
        raise PremortemError("POLICY_CONTEXT_MISMATCH",
                             f"plan의 run_id({plan.get('run_id')})가 이번 실행({run_id})과 다름. 다른 실행의 정책 결과를 섞지 않음")
    plan_digest = plan.get("digest")
    if plan_digest and registry_digest and plan_digest != registry_digest:
        raise PremortemError("POLICY_CONTEXT_MISMATCH", "plan의 이미지 digest가 이번 실행과 다름")
    requires = []
    for item in plan.get("requires") or []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise PremortemError("SCHEMA_INVALID", "requires 항목에는 문자열 id가 있어야 함")
        entry = {"id": item["id"], "hint": item.get("hint"), "rule_id": item.get("rule_id"),
                 "allowed_targets": item.get("allowed_targets"),
                 "meaning_of_allowed_targets": "이 조건을 충족한 뒤 가능한 후보 위치. 현재 배포 허가가 아니며 정책을 다시 평가해야 함"}
        if item["id"] not in KNOWN_REQUIREMENTS:
            entry["handling"] = "지원하지 않는 요구. 원문 그대로 두고 사람이 처리(manual_action)"
        else:
            entry["handling"] = KNOWN_REQUIREMENTS[item["id"]]
        requires.append(entry)
    return requires


def unsupported(requires: list) -> list:
    return [r["id"] for r in requires if r["id"] not in KNOWN_REQUIREMENTS]
