"""원본 판정을 바꾸지 않는 조건별 불일치 보기. 실행이나 파일 접근은 하지 않는다."""

CONDITIONS = ("none", "restart", "replace")


def _integer(value):
    return type(value) is int  # JSON true/false를 요청 수나 번호로 받지 않는다.


def _validated(result):
    if not isinstance(result, dict) or type(result.get("passed")) is not bool:
        raise ValueError("matrix: 결과 객체와 bool passed가 필요합니다")
    entries, mismatches = result.get("replay"), result.get("mismatches")
    if not isinstance(entries, list) or not entries or not isinstance(mismatches, list):
        raise ValueError("matrix: 비어 있지 않은 replay와 mismatches 목록이 필요합니다")
    conditions = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("matrix: 조건 결과는 객체여야 합니다")
        name = entry.get("condition")
        if not isinstance(name, str) or name not in CONDITIONS or name in conditions:
            raise ValueError("matrix: 알 수 없거나 중복된 조건입니다")
        total, matched = entry.get("total"), entry.get("matched")
        if not _integer(total) or not _integer(matched) or not 0 <= matched <= total or total == 0:
            raise ValueError("matrix: total/matched는 유효한 정수여야 하며 total은 양수여야 합니다")
        if "error" in entry and (not isinstance(entry["error"], str) or not entry["error"].strip()):
            raise ValueError("matrix: error는 비어 있지 않은 문자열이어야 합니다")
        conditions[name] = entry

    failures = {name: set() for name in conditions}
    labels = {}
    for mismatch in mismatches:
        if not isinstance(mismatch, dict):
            raise ValueError("matrix: 불일치는 객체여야 합니다")
        name, index, label = (mismatch.get(key) for key in ("condition", "index", "request"))
        if not isinstance(name, str) or name not in conditions:
            raise ValueError("matrix: 결과가 없는 조건의 불일치입니다")
        if not _integer(index) or not 1 <= index <= conditions[name]["total"]:
            raise ValueError("matrix: 불일치 요청 번호가 범위를 벗어났습니다")
        if index in failures[name]:
            raise ValueError("matrix: 같은 조건에 중복된 불일치 요청 번호가 있습니다")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("matrix: 요청 라벨이 필요합니다")
        if index in labels and labels[index] != label:
            raise ValueError("matrix: 같은 요청 번호의 라벨이 조건마다 다릅니다")
        labels[index] = label
        failures[name].add(index)

    for name, entry in conditions.items():
        accounted = entry["matched"] + len(failures[name])
        if accounted > entry["total"] or ("error" not in entry and accounted != entry["total"]):
            raise ValueError("matrix: 일치 수와 불일치 목록이 전체 요청 수와 맞지 않습니다")
    expected_passed = all("error" not in entry and entry["matched"] == entry["total"]
                          for entry in entries)
    if result["passed"] != expected_passed:
        raise ValueError("matrix: 원본 passed와 조건별 결과가 모순됩니다")
    return conditions, failures, labels


def _cell(text):
    return text.replace("|", "\\|").replace("\r", "\\r").replace("\n", "\\n")


def matrix_lines(result) -> list[str]:
    """불일치 번호의 합집합만 표시한다. 모순된 입력은 ValueError로 거부한다.

    완료된 조건의 수치와 불일치 목록이 일관될 때만 나머지를 일치로 표시한다.
    중단 조건은 어느 번호까지 일치했는지 알 수 없어 불일치 이외 셀은 확인불가다.
    서로 다른 total은 같은 요청 집합이라고 볼 수 없어 일치/추가 불일치를 추론하지 않는다.
    """
    conditions, failures, labels = _validated(result)
    same_total = len({entry["total"] for entry in conditions.values()}) == 1
    complete = (len(conditions) == len(CONDITIONS) and same_total
                and all("error" not in entry for entry in conditions.values()))
    lines = [f"원본 passed: {str(result['passed']).lower()} (배포 허가를 뜻하지 않습니다)"]
    states = []
    for name in CONDITIONS:
        entry = conditions.get(name)
        if entry is None:
            states.append(f"{name}: 누락")
        else:
            state = "중단" if "error" in entry else "완료"
            states.append(f"{name}: {entry['matched']}/{entry['total']} ({state})")
    lines.append(", ".join(states))
    lines += ["| 요청 번호 | 요청 | none | restart | replace |",
              "| --- | --- | --- | --- | --- |"]
    for index in sorted(labels):
        cells = []
        for name in CONDITIONS:
            entry = conditions.get(name)
            if index in failures.get(name, set()):
                cells.append("불일치")
            elif entry is not None and "error" not in entry and same_total:
                cells.append("일치")
            else:
                cells.append("확인불가")
        lines.append(f"| {index} | {_cell(labels[index])} | " + " | ".join(cells) + " |")
    if not labels:
        lines.append("기록된 불일치 없음." if complete else "기록된 불일치 없음 (전체 검증 통과를 뜻하지 않음).")
    for previous, current in (("none", "restart"), ("restart", "replace")):
        if complete:
            extra = ", ".join(str(index) for index in sorted(failures[current] - failures[previous])) or "없음"
        else:
            extra = "확인불가 (조건 누락·중단 또는 전체 요청 수 차이)"
        lines.append(f"{current}: {previous} 대비 추가 불일치 요청 번호: {extra}")
    lines.append("응답 요약의 잘린 원문은 복원하지 않으며, related_fact를 원인 확정으로 해석하지 않습니다.")
    return lines
