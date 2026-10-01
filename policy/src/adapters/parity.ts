/**
 * parity 인계 묶음(parity-handoff-v1-proposal) → test_result.json 변환기 (순수 함수).
 *
 * 입력은 테스트 파트(parity)가 `python -m parity.handoff` 로 만든 묶음 하나와, 선택으로 `parity test` 가
 * 함께 쓰는 실행 진단(result.diagnostics.json)이다. 묶음 안의 result 는 원본 result.json 그대로다.
 *
 * 원칙: 변환기는 관찰된 사실만 옮기고 판단하지 않는다.
 *   - passed 는 원본 종합값 그대로 (의미를 바꾸지 않는다). 판단은 policy.yaml 의 R1 / R1b / R1c 가 facts.conditions 로 한다.
 *   - match 는 기준 조건 none 의 결과. 조건별 수치는 facts.conditions[] 에만 싣는다.
 *   - facts.conditions[]: 조건마다 { name, total, matched, failed, mismatches[] }.
 *     mismatches[] 는 { index, request, related_fact?, related_storage?, related_kind? } 로, related_* 는
 *     원본 mismatch 의 related_fact(path) 를 원본 facts[] 에서 찾아 붙인 조회값이다 (판단이 아니다).
 *   - facts.storage[]: 원본 facts[] 의 kind, path, storage.
 *   - facts.db: facts[] 에 kind=sqlite 가 있을 때만 "sqlite". 없으면 키 생략 (none 으로 쓰지 않는다. 외부 DB 를 못 본 것일 수 있다).
 *   - facts.writes_local_file: kind 가 local_upload / local_file 인 path 만 (sqlite 경로는 R5 담당이라 제외).
 *   - 없는 값은 null 대신 키를 생략한다 (조건 DSL 의 exists 는 null 도 "있음" 으로 본다).
 *
 * 변환을 거부하는 경우 (ParityAdapterError): 재생이 중단된 조건이 있음(replay[].error), 진단 status 가 completed 가 아님,
 * 진단의 registry_digest 가 metadata.digest 와 다름, 조건이 none / restart / replace 정확히 한 번씩이 아님
 * (빠짐·중복·모르는 조건. parity CLI 기본값은 none,restart 라 replace 를 빼먹은 결과가 들어오는 것을 막는다),
 * 조건·불일치 수가 서로 맞지 않음.
 * 경고만 하는 경우: metadata.digest 가 진단의 local_image_id 와 같음 (레지스트리 위치가 정해지면 오류로 바꾼다).
 */
import { z } from "zod";
import {
  type ConditionFact,
  type ConditionMismatch,
  DigestSchema,
  type Facts,
  SourceRevisionSchema,
  type StorageFact,
  type TestResult,
  TestResultSchema,
} from "../schema.js";

export const PARITY_HANDOFF_FORMAT = "parity-handoff-v1-proposal";
export const PARITY_DIAGNOSTICS_FORMAT = "parity-execution-v1";
/** 기준 조건. match 는 이 조건의 결과다 */
export const BASELINE_CONDITION = "none";
/** 정책 판단(R1 / R1b / R1c)에 필요한 조건. 이 세 개가 정확히 한 번씩 있어야 변환한다 */
export const REQUIRED_CONDITIONS: readonly string[] = [BASELINE_CONDITION, "restart", "replace"];
/** facts.db = "sqlite" 가 되는 사실 종류 */
export const SQLITE_KIND = "sqlite";
/** facts.writes_local_file 에 들어가는 사실 종류 */
export const LOCAL_FILE_KINDS: readonly string[] = ["local_upload", "local_file"];

// ---------------------------------------------------------------------------
// 입력 형식 (parity/parity/handoff.py 의 검증 규칙과 같은 범위. 모르는 키는 허용)
// ---------------------------------------------------------------------------
export const ParityFactSchema = z
  .looseObject({
    kind: z.string().min(1).describe("sqlite / local_upload / local_file"),
    path: z.string().min(1),
    storage: z.string().min(1).describe("현재는 항상 container_layer"),
    evidence: z.string().min(1),
  })
  .describe("parity facts[] 항목");

export const ParityReplayEntrySchema = z
  .looseObject({
    condition: z.string().min(1),
    /** parity handoff.py 와 같이 1 이상. 요청 0건은 판정이 아니다 */
    total: z.number().int().positive(),
    matched: z.number().int().nonnegative(),
    /** 재생이 중단됐을 때만 있다. 있으면 변환하지 않는다 */
    error: z.string().min(1).optional(),
  })
  .describe("parity replay[] 항목 (조건 하나)");

export const ParityMismatchSchema = z
  .looseObject({
    condition: z.string().min(1),
    index: z.number().int().positive(),
    request: z.string().min(1),
    expected: z.string(),
    actual: z.string(),
    /** 관련 있어 보이는 사실의 path. 없으면 null (parity 형식) */
    related_fact: z.string().min(1).nullable().optional(),
  })
  .describe("parity mismatches[] 항목");

export const ParityResultSchema = z
  .looseObject({
    stage: z.literal("test").describe("배포 전 test 결과만 받는다 (verify 는 배포 후 확인)"),
    commit: z.string().describe("도구 저장소 기준 커밋. 앱 소스 SHA 가 아니므로 쓰지 않는다"),
    image: z.string().describe("이미지 이름 또는 로컬 image ID. 레지스트리 digest 가 아니므로 쓰지 않는다"),
    passed: z.boolean(),
    facts: z.array(ParityFactSchema),
    replay: z.array(ParityReplayEntrySchema).min(1),
    mismatches: z.array(ParityMismatchSchema),
  })
  .describe("parity result.json 원본");
export type ParityResult = z.infer<typeof ParityResultSchema>;

export const ParityHandoffSchema = z
  .looseObject({
    format: z.literal(PARITY_HANDOFF_FORMAT),
    metadata: z.looseObject({
      run_id: TestResultSchema.shape.run_id,
      app: z.string().min(1),
      source_revision: SourceRevisionSchema,
      digest: DigestSchema,
    }),
    result: ParityResultSchema,
  })
  .describe("python -m parity.handoff 가 만드는 인계 묶음");
export type ParityHandoff = z.infer<typeof ParityHandoffSchema>;

export const ParityDiagnosticsSchema = z
  .looseObject({
    format: z.literal(PARITY_DIAGNOSTICS_FORMAT),
    status: z.string().min(1).describe("running / completed / error"),
    phase: z.string().optional(),
    local_image_id: z.string().nullable().optional(),
    registry_digest: z.string().nullable().optional(),
    error: z.unknown().optional(),
  })
  .describe("parity test 가 result.json 옆에 쓰는 실행 진단 (result.diagnostics.json)");
export type ParityDiagnostics = z.infer<typeof ParityDiagnosticsSchema>;

// ---------------------------------------------------------------------------
// 변환
// ---------------------------------------------------------------------------
export class ParityAdapterError extends Error {}

export interface ParityAdapterOutput {
  test: TestResult;
  /** 사람에게 알릴 것. 변환은 됐지만 확인이 필요한 점 */
  warnings: string[];
}

function fail(message: string): never {
  throw new ParityAdapterError(message);
}

/** 진단 파일과 묶음의 식별자를 맞춰 본다. 오류는 던지고, 경고는 목록에 더한다 */
function checkDiagnostics(diagnostics: ParityDiagnostics, digest: string, warnings: string[]): void {
  if (diagnostics.status !== "completed") {
    const detail = diagnostics.error !== undefined && diagnostics.error !== null ? ` (${JSON.stringify(diagnostics.error)})` : "";
    fail(`실행 진단의 status 가 ${diagnostics.status} 입니다 (completed 가 아님)${detail}. 테스트가 끝까지 실행되지 않은 결과는 정책 판단에 넣지 않습니다`);
  }
  if (diagnostics.registry_digest !== undefined && diagnostics.registry_digest !== null && diagnostics.registry_digest !== digest) {
    fail(`실행 진단의 registry_digest(${diagnostics.registry_digest})가 metadata.digest(${digest})와 다릅니다. 어느 이미지를 검사했는지 확인하세요`);
  }
  if (diagnostics.local_image_id !== undefined && diagnostics.local_image_id !== null && diagnostics.local_image_id === digest) {
    warnings.push(
      "metadata.digest 가 실행 진단의 local_image_id 와 같습니다. 레지스트리 digest 가 아니라 로컬 image ID 를 넣었을 수 있습니다 (레지스트리 위치가 정해지면 오류로 바뀝니다)",
    );
  }
}

function toMismatch(mismatch: ParityResult["mismatches"][number], factsByPath: ReadonlyMap<string, ParityResult["facts"][number]>): ConditionMismatch {
  const out: ConditionMismatch = { index: mismatch.index, request: mismatch.request };
  const relatedPath = mismatch.related_fact ?? undefined;
  if (relatedPath === undefined) return out;
  out.related_fact = relatedPath;
  const fact = factsByPath.get(relatedPath);
  if (fact !== undefined) {
    out.related_storage = fact.storage;
    out.related_kind = fact.kind;
  }
  return out;
}

export function adaptParityHandoff(handoff: ParityHandoff, diagnostics?: ParityDiagnostics): ParityAdapterOutput {
  const { metadata, result } = handoff;
  const warnings: string[] = [];

  // 1) 재생이 끝까지 됐는지. 중단된 조건이 있으면 판정 자체가 불완전하므로 변환하지 않는다
  const interrupted = result.replay.filter((entry) => entry.error !== undefined);
  if (interrupted.length > 0) {
    fail(`재생이 중단된 조건이 있습니다: ${interrupted.map((e) => `${e.condition} (${e.error})`).join(", ")}. 테스트를 다시 실행하세요`);
  }
  if (diagnostics !== undefined) checkDiagnostics(diagnostics, metadata.digest, warnings);

  // 2) 조건이 none / restart / replace 정확히 한 번씩인지, 불일치가 조건과 맞는지
  const seen = new Set<string>();
  for (const entry of result.replay) {
    if (seen.has(entry.condition)) fail(`같은 조건이 두 번 있습니다: ${entry.condition}`);
    seen.add(entry.condition);
    if (entry.matched > entry.total) fail(`${entry.condition}: matched(${entry.matched})가 total(${entry.total})보다 큽니다`);
  }
  const unknown = [...seen].filter((name) => !REQUIRED_CONDITIONS.includes(name));
  if (unknown.length > 0) fail(`모르는 조건이 있습니다: ${unknown.join(", ")} (받는 조건: ${REQUIRED_CONDITIONS.join(", ")})`);
  const missing = REQUIRED_CONDITIONS.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    fail(`필요한 조건이 빠졌습니다: ${missing.join(", ")} (재생한 조건: ${[...seen].join(", ")}). 정책 판단에는 ${REQUIRED_CONDITIONS.join(", ")} 세 조건이 모두 필요합니다. parity test 를 --conditions ${REQUIRED_CONDITIONS.join(",")} 으로 실행하세요`);
  }
  const baseline = result.replay.find((entry) => entry.condition === BASELINE_CONDITION)!;
  for (const mismatch of result.mismatches) {
    if (!seen.has(mismatch.condition)) fail(`불일치가 모르는 조건을 가리킵니다: ${mismatch.condition} (요청 ${mismatch.index})`);
  }
  for (const entry of result.replay) {
    const own = result.mismatches.filter((m) => m.condition === entry.condition);
    const unmatched = entry.total - entry.matched;
    if (own.length !== unmatched) fail(`${entry.condition}: 불일치 ${own.length}건인데 total-matched 는 ${unmatched} 입니다. 원본이 손상됐을 수 있습니다`);
    for (const m of own) {
      if (m.index > entry.total) fail(`${entry.condition}: 요청 번호 ${m.index} 가 total(${entry.total})을 넘습니다`);
    }
  }

  // 3) 사실 옮기기 (판단 없음)
  const factsByPath = new Map(result.facts.map((f) => [f.path, f] as const));
  const conditions: ConditionFact[] = result.replay.map((entry) => ({
    name: entry.condition,
    total: entry.total,
    matched: entry.matched,
    failed: entry.matched < entry.total,
    mismatches: result.mismatches.filter((m) => m.condition === entry.condition).map((m) => toMismatch(m, factsByPath)),
  }));
  const storage: StorageFact[] = result.facts.map((f) => ({ kind: f.kind, path: f.path, storage: f.storage }));
  const writesLocalFile = [...new Set(result.facts.filter((f) => LOCAL_FILE_KINDS.includes(f.kind)).map((f) => f.path))];

  const facts: Facts = {
    ...(result.facts.some((f) => f.kind === SQLITE_KIND) ? { db: "sqlite" as const } : {}),
    ...(writesLocalFile.length > 0 ? { writes_local_file: writesLocalFile } : {}),
    conditions,
    storage,
  };

  const test = TestResultSchema.parse({
    run_id: metadata.run_id,
    app: metadata.app,
    digest: metadata.digest,
    source_revision: metadata.source_revision,
    passed: result.passed,
    match: { total: baseline.total, matched: baseline.matched },
    failures: result.mismatches,
    facts,
  });
  return { test, warnings };
}

/** 사람이 읽는 조건별 요약: "none 20/20, restart 14/20, replace 13/20" */
export function summarizeConditions(conditions: readonly ConditionFact[]): string {
  return conditions.map((c) => `${c.name} ${c.matched}/${c.total}`).join(", ");
}
