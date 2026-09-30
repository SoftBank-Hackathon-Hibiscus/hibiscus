"""판정 규칙 (IMPLEMENTATION_SPEC 10절).

- 조건: 필요한 요청을 실제로 전부 실행했고 전부 일치해야 passed. 0건은 passed가 아니다.
- 전체: 필수 조건이 모두 passed여야 passed. 우선순위는 error > failed > inconclusive > passed.
  누락·skipped·inconclusive 필수 조건이 있으면 passed가 될 수 없다.
- 일치율은 설명용이다. 큰 합계가 한 조건의 실패를 가리지 않는다.
"""

from .errors import PremortemError

CONDITION_STATUSES = ("passed", "failed", "inconclusive", "skipped", "error")


def condition_status(expected: int, executed: int, matched: int, mismatches: list) -> str:
    if expected == 0 or executed == 0:
        return "inconclusive"
    if expected == executed == matched and not mismatches:
        return "passed"
    return "failed"


def check_condition(condition: dict) -> None:
    name = condition["name"]
    expected, executed, matched = condition["expected_count"], condition["executed_count"], condition["matched_count"]
    if condition["status"] not in CONDITION_STATUSES:
        raise PremortemError("RESULT_INVALID", f"{name}: 모르는 상태 {condition['status']}")
    if not 0 <= matched <= executed <= expected:
        raise PremortemError("RESULT_INVALID",
                             f"{name}: 카운터 범위 오류 matched={matched} executed={executed} expected={expected}")
    if condition["status"] == "passed" and not (expected == executed == matched > 0 and not condition["mismatches"]):
        raise PremortemError("RESULT_INVALID", f"{name}: 전부 실제로 일치하지 않았는데 passed로 표시됨")
    for mismatch in condition["mismatches"]:
        if not 1 <= mismatch["request_index"] <= max(expected, 1):
            raise PremortemError("RESULT_INVALID", f"{name}: 기록에 없는 요청 번호 {mismatch['request_index']}")


def overall_status(required: list, conditions: list) -> str:
    if not required or "none" not in required or len(set(required)) != len(required):
        raise PremortemError("INPUT_INVALID", "필수 조건에는 none이 있어야 하고 이름이 겹치면 안 됨")
    names = [c["name"] for c in conditions]
    if len(names) != len(set(names)):
        raise PremortemError("INPUT_INVALID", "같은 조건의 결과가 두 번 있음")
    for condition in conditions:
        check_condition(condition)
    by_name = {c["name"]: c for c in conditions}
    statuses = [by_name[name]["status"] if name in by_name else "inconclusive" for name in required]
    if "error" in statuses:
        return "error"
    if "failed" in statuses:
        return "failed"
    if all(status == "passed" for status in statuses):
        return "passed"
    return "inconclusive"


def fault_positions(fault_after, request_count: int) -> list:
    """장애 주입 위치. 기록이 1건 이하면 빈 목록(조건 주입이 의미 없음 → inconclusive)."""
    if request_count < 2:
        return []
    if not fault_after:
        return [request_count // 2]
    seen = set()
    for position in fault_after:
        if isinstance(position, bool) or not isinstance(position, int) or not 1 <= position < request_count or position in seen:
            raise PremortemError("INPUT_INVALID",
                                 f"장애 주입 위치는 1 이상 {request_count - 1} 이하의 서로 다른 정수여야 함: {position!r}")
        seen.add(position)
    return sorted(seen)
