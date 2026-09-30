"""2단계: 노이즈 탐지.

노이즈 = "같은 조건으로 재생해도 **재생할 때마다** 달라지는 값" (생성 시각, 랜덤 토큰 등).
방법: 초기 상태에서 기록을 runs 번(2 이상) 재생한다. 기록과 다른 필드를 모두 '후보'로 모으고,
아래 판정을 통과한 후보만 '적용 규칙'이 된다.

  판정(reason)            결정       뜻
  varies_between_runs    applied    재생끼리도 값이 서로 다름 → 노이즈
  consistent_difference  rejected   재생끼리는 같고 기록과만 다름 → 노이즈가 아니라 실제 차이
  status_code            rejected   상태코드는 자동 제외 금지
  connection_error       rejected   재생 중 연결 실패/미실행 → 비교 불가
  missing_field          rejected   필드가 기록이나 재생 중 한쪽에 없음 (필수 필드 누락 가능)
  type_changed           rejected   값의 타입이 바뀜 (예: 문자열 → null)
  whole_body             rejected   본문 전체가 한 덩어리로 달라짐 → 제외하면 검증할 것이 없음

예) 기록은 200 인데 두 재생이 모두 500 → status 는 status_code, 본문 필드는 missing_field 로
거부된다. 적용 규칙이 없으므로 test 에서 불일치로 잡힌다.

출력 형식 (records/<기록이름>.noise.json):
  {"runs": 2,
   "rules":      [{"index": 4, "request": "POST /posts", "fields": ["body.created_at"]}],   ← test/verify 가 쓰는 적용 규칙
   "candidates": [{"index": 4, "request": "POST /posts", "field": "body.created_at",
                   "decision": "applied", "reason": "varies_between_runs"}, ...]}        ← 판정 기록
"""
import json
from pathlib import Path

from .compare import MISSING, field_diffs, generalize, same_value, type_class, view_recorded, view_replayed
from .record import request_label
from .replay import replay

APPLIED = "varies_between_runs"
# 거부 이유가 여러 개면 앞쪽을 대표로 보고한다.
REJECT_PRIORITY = ["connection_error", "status_code", "whole_body", "missing_field", "type_changed",
                   "consistent_difference"]


def default_noise_path(record_path):
    p = Path(record_path)
    return str(p.with_name(p.stem + ".noise.json"))


def classify(path, values):
    """values = [기록 값, 재생1 값, 재생2 값, ...] 로 한 경로를 판정한다."""
    if path == "status":
        return "status_code"
    if path == "body":
        return "whole_body"
    if any(v is MISSING for v in values):
        return "missing_field"
    if len({type_class(v) for v in values}) > 1:
        return "type_changed"
    replays = values[1:]
    if all(same_value(v, replays[0]) for v in replays[1:]):
        return "consistent_difference"
    return APPLIED


def analyze(records, runs):
    """runs = [재생1 응답 목록, 재생2 응답 목록, ...] (각각 records 와 같은 순서)."""
    rules, candidates = [], []
    for pos, rec in enumerate(records):
        label = request_label(rec)
        expected = view_recorded(rec["response"])
        replays = [view_replayed(run[pos]) for run in runs]

        failure = next((v.failure for v in replays if v.failure), None)
        if failure:
            candidates.append({"index": rec["index"], "request": label, "field": "*",
                               "decision": "rejected", "reason": "connection_error"})
            continue

        samples = [expected.flat()] + [v.flat() for v in replays]
        reasons = {}
        for path in sorted({d.path for v in replays for d in field_diffs(expected, v)}):
            values = [s.get(path, MISSING) for s in samples]
            reasons.setdefault(generalize(path), []).append(classify(path, values))

        applied = []
        for pattern, found in sorted(reasons.items()):
            rejected = [r for r in found if r != APPLIED]
            reason = min(rejected, key=REJECT_PRIORITY.index) if rejected else APPLIED
            candidates.append({"index": rec["index"], "request": label, "field": pattern,
                               "decision": "rejected" if rejected else "applied", "reason": reason})
            if not rejected:
                applied.append(pattern)
        if applied:
            rules.append({"index": rec["index"], "request": label, "fields": applied})
    return {"runs": len(runs), "rules": rules, "candidates": candidates}


def detect(records, target, runs=2, prepare=None, log=print, **replay_options):
    """prepare() 로 대상을 초기 상태로 만든 뒤 재생하는 것을 runs 번 반복하고 analyze 한다."""
    if runs < 2:
        raise ValueError("--runs 는 2 이상이어야 합니다 (재생끼리 비교해야 노이즈와 실제 차이를 구분할 수 있음)")
    results = []
    for run in range(1, runs + 1):
        log(f"[noise] {run}/{runs}회차: 초기화 → 기록 재생")
        if prepare:
            prepare()
        results.append(replay(records, target, log=log if run == 1 else None, **replay_options).responses)
    return analyze(records, results)


def save(noise, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(noise, f, ensure_ascii=False, indent=2)
        f.write("\n")


def load(path, log=print):
    """noise.json 의 적용 규칙 → {요청번호: {무시할 경로, ...}}. candidates 는 읽지 않는다."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    rules = {}
    for rule in data.get("rules", []):
        fields = set(rule["fields"])
        if "status" in fields:
            log(f"[noise] 경고: #{rule['index']} 의 'status' 규칙은 무시합니다 (상태코드는 제외 불가)")
        if "body" in fields:
            log(f"[noise] 경고: #{rule['index']} 에 본문 전체를 무시하는 규칙이 있어 상태코드만 검증됩니다")
        rules[rule["index"]] = fields
    return rules
