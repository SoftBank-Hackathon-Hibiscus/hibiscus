/**
 * 모듈 간 주고받는 JSON 파일과 policy.yaml 의 zod 스키마.
 * 여기서 타입도 함께 내보내므로 engine.ts / cli.ts 는 이 파일만 참조한다.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 입력 1: test_result.json (테스트 파트가 만듦)
// ---------------------------------------------------------------------------
export const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "digest 는 'sha256:' 뒤에 소문자 hex 64자여야 합니다")
  .describe("컨테이너 이미지 지문. 'sha256:' + 소문자 hex 64자. 테스트한 이미지 = 결정한 이미지 = 서명·배포할 이미지");

const RunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "run_id 는 영문·숫자·._- 만, 1~64자여야 합니다")
  .describe("파이프라인 실행 id. 영문·숫자·._- 만, 1~64자. 모든 파일이 같은 값을 가져야 한다");

/**
 * source_revision: 테스트한 소스의 커밋 SHA (백엔드가 webhook 의 커밋 SHA 를 고정해서 넘긴다).
 * 소문자 hex 7~40자. 출력(plan, rollback_plan, 결정 기록)에는 값이 있을 때만 그대로 실린다.
 */
export const SourceRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "source_revision 은 소문자 hex 7~40자여야 합니다")
  .describe("테스트한 소스의 커밋 SHA. 소문자 hex 7~40자");

/**
 * 입력 쪽 source_revision. 아직 선택이며, 테스트 파트가 짧은 해시나 "unknown" 을 줄 수 있다.
 * "unknown" 은 없는 것으로 취급한다 (undefined 로 바뀌어 plan_hash 에도 들어가지 않는다).
 */
export const SOURCE_REVISION_UNKNOWN = "unknown";
const SourceRevisionInputSchema = z
  .union([SourceRevisionSchema, z.literal(SOURCE_REVISION_UNKNOWN).transform((): undefined => undefined)])
  .optional()
  .describe(`테스트한 소스의 커밋 SHA (선택). 소문자 hex 7~40자. "${SOURCE_REVISION_UNKNOWN}" 은 없는 것으로 취급한다`);

// ---------------------------------------------------------------------------
// 파괴적 DB 마이그레이션 판정 결과 (src/migration/ 이 만든다. test_result.facts.migration 에 실린다)
// ---------------------------------------------------------------------------
export const MIGRATION_KINDS = [
  "drop_table",
  "drop_column",
  "rename_table",
  "rename_column",
  "alter_column_type",
  "add_not_null_without_default",
  "set_not_null",
  "truncate",
] as const;
export const MigrationKindSchema = z.enum(MIGRATION_KINDS);
export type MigrationKind = z.infer<typeof MigrationKindSchema>;

export const MigrationFindingSchema = z
  .object({
    kind: MigrationKindSchema.describe("파괴적 변경의 종류"),
    statement: z.string().describe("해당 SQL 문장 (한 줄로 줄임)"),
    evidence: z.string().describe("위치 '파일:줄'"),
  })
  .describe("파괴적 변경 하나");
export type MigrationFinding = z.infer<typeof MigrationFindingSchema>;

export const MigrationReportSchema = z
  .object({
    destructive: z.boolean().describe("파괴적 변경이 하나라도 있는지. R7 이 읽는다"),
    backward_compatible: z.boolean().describe("이전 버전과 호환되는지 = 파괴적 변경이 없을 때 true"),
    findings: z.array(MigrationFindingSchema).describe("파괴적 변경 목록. 없으면 빈 배열"),
  })
  .describe("파괴적 DB 마이그레이션 판정. 실행기(src/stage.ts)가 facts.migration 이 없으면 채운다");
export type MigrationReport = z.infer<typeof MigrationReportSchema>;

// ---------------------------------------------------------------------------
// 조건별 재생 결과 (facts.conditions) 와 저장 사실 (facts.storage).
// 테스트 파트(parity)의 원본을 변환기(src/adapters/parity.ts)가 관찰된 사실 그대로 옮긴 것이다.
// 판단(어느 조건의 불일치가 앱 결함이고 어느 것이 저장 방식의 환경 제약인지)은 policy.yaml 의 규칙이 한다.
// 없는 값은 null 대신 키를 생략한다: 조건 DSL 의 exists 는 null 도 "있음" 으로 보기 때문이다.
// ---------------------------------------------------------------------------
export const ConditionMismatchSchema = z
  .looseObject({
    index: z.number().int().positive().describe("기록 파일의 요청 번호 (1부터 그 조건의 total 까지)"),
    request: z.string().min(1).describe('요청 한 줄 (예: "GET /posts")'),
    related_fact: z.string().min(1).optional().describe("관련 있어 보이는 저장 사실의 path (테스트 파트의 힌트. 원인 증명이 아님). 없으면 키를 생략한다"),
    related_storage: z.string().min(1).optional().describe("related_fact 가 가리키는 사실의 storage (예: container_layer). related_fact 가 없으면 생략. 있으면 facts.storage 에 같은 path·kind·storage 항목이 있어야 한다"),
    related_kind: z.string().min(1).optional().describe("related_fact 가 가리키는 사실의 kind (sqlite, local_upload, local_file). R1c 가 읽는다. 없으면 생략. 있으면 facts.storage 에 같은 path·kind·storage 항목이 있어야 하고, sqlite 면 facts.db 가 sqlite, local_upload / local_file 이면 facts.writes_local_file 에 그 path 가 있어야 한다"),
  })
  .describe("한 조건에서 기록과 어긋난 요청 하나");
export type ConditionMismatch = z.infer<typeof ConditionMismatchSchema>;

/** 정책 판단(R1 / R1b / R1c)에 필요한 조건. conditions 가 있으면 이 세 개가 정확히 한 번씩 있어야 한다 */
export const CONDITION_NAMES = ["none", "restart", "replace"] as const;
export const ConditionNameSchema = z.enum(CONDITION_NAMES).describe("조건 이름. none(기준선) / restart(재시작) / replace(컨테이너 교체)");
export type ConditionName = z.infer<typeof ConditionNameSchema>;
export function isConditionName(value: string): value is ConditionName {
  return (CONDITION_NAMES as readonly string[]).includes(value);
}
/** 기준 조건. test_result.match 는 이 조건의 결과다 (변환기 src/adapters/parity.ts 가 넣고, TestResultSchema 가 같은지 검사한다) */
export const BASELINE_CONDITION = "none" as const satisfies ConditionName;

export const ConditionFactSchema = z
  .looseObject({
    name: ConditionNameSchema,
    total: z.number().int().positive().describe("이 조건에서 재생한 요청 수 (1 이상. 요청 0건은 판정이 아니다)"),
    matched: z.number().int().nonnegative().describe("응답이 일치한 요청 수 (total 이하)"),
    failed: z.boolean().describe("이 조건에서 어긋난 요청이 하나라도 있는지. matched < total 과 같아야 한다. R1 / R1b / R1c 가 읽는다"),
    mismatches: z.array(ConditionMismatchSchema).describe("어긋난 요청 목록 (total - matched 개). 없으면 빈 배열"),
  })
  .superRefine((c, ctx) => {
    // 규칙이 failed 와 mismatches 를 읽으므로 수치와 어긋난 값이 들어오면 거부한다 (JSON Schema 에는 표현되지 않는 검사).
    // --handoff(변환기)와 --test(직접 입력) 어느 경로로 와도 같은 조건을 보장한다
    if (c.matched > c.total) ctx.addIssue({ code: "custom", path: ["matched"], message: `matched(${c.matched})는 total(${c.total}) 이하여야 합니다` });
    if (c.failed !== c.matched < c.total) ctx.addIssue({ code: "custom", path: ["failed"], message: `failed 는 matched < total (${c.matched} < ${c.total}) 과 같아야 합니다` });
    if (c.mismatches.length !== c.total - c.matched) {
      ctx.addIssue({ code: "custom", path: ["mismatches"], message: `mismatches 는 total - matched (${c.total - c.matched})개여야 하는데 ${c.mismatches.length}개입니다` });
    }
    // 요청 번호는 1 이상(ConditionMismatchSchema 의 positive) total 이하이고, 같은 조건 안에서 한 번씩이다
    // (다른 조건과 같은 번호는 정상: 같은 기록을 조건마다 재생한다). 변환기(adapters/parity.ts)와 같은 범위다
    const seen = new Set<number>();
    for (const [j, m] of c.mismatches.entries()) {
      if (m.index > c.total) ctx.addIssue({ code: "custom", path: ["mismatches", j, "index"], message: `요청 번호 ${m.index} 가 total(${c.total})을 넘습니다` });
      if (seen.has(m.index)) ctx.addIssue({ code: "custom", path: ["mismatches", j, "index"], message: `같은 조건 안에 요청 번호 ${m.index} 가 두 번 있습니다` });
      seen.add(m.index);
    }
  })
  .describe("조건 하나의 재생 결과");
export type ConditionFact = z.infer<typeof ConditionFactSchema>;

/** conditions 배열: none / restart / replace 가 정확히 한 번씩 (빠짐·중복 거부. 모르는 이름은 name enum 이 거부) */
export const ConditionFactsSchema = z
  .array(ConditionFactSchema)
  .min(CONDITION_NAMES.length)
  .max(CONDITION_NAMES.length)
  .superRefine((conditions, ctx) => {
    const names = conditions.map((c) => c.name);
    const missing = CONDITION_NAMES.filter((n) => !names.includes(n));
    const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
    if (missing.length > 0) ctx.addIssue({ code: "custom", message: `조건이 빠졌습니다: ${missing.join(", ")} (none, restart, replace 가 정확히 한 번씩 있어야 합니다)` });
    if (duplicated.length > 0) ctx.addIssue({ code: "custom", message: `같은 조건이 두 번 있습니다: ${[...new Set(duplicated)].join(", ")}` });
  })
  .describe("조건별 재생 결과 (none / restart / replace 정확히 한 번씩). 있으면 R1 / R1b / R1c 가 이것으로 판단하고 passed 는 원본 종합값 보존용이다. 없으면 R1 이 passed 를 본다");

/** facts.db = "sqlite" 가 되는 저장 사실 종류 (R5 담당) */
export const SQLITE_KIND = "sqlite";
/** facts.writes_local_file 에 들어가는 저장 사실 종류 (R6 담당) */
export const LOCAL_FILE_KINDS: readonly string[] = ["local_upload", "local_file"];

export const StorageFactSchema = z
  .looseObject({
    kind: z.string().min(1).describe("sqlite(파일 헤더로 판별) / local_upload(업로드 폴더) / local_file(그 밖의 파일)"),
    path: z.string().min(1).describe("컨테이너 안의 경로"),
    storage: z.string().min(1).describe("저장 위치. container_layer = 재시작으로는 남지만 컨테이너를 새로 만들면 사라진다"),
  })
  .describe("컨테이너 안에 남은 상태 하나 (테스트 파트의 facts[] 원본에서 kind, path, storage 만)");
export type StorageFact = z.infer<typeof StorageFactSchema>;

/**
 * 테스트 파트가 관찰한 사실 중 "정책이 읽는 키" 만 타입을 정한다.
 * 여기 없는 키는 자유롭게 넣을 수 있고 그대로 보존된다 (정책 엔진은 읽지 않는다).
 * 정의된 키에 허용되지 않은 값(예: "SQLite", 숫자)이 오면 형식 오류다.
 *
 * conditions 가 있는 입력에서는 passed 는 테스트 파트 원본의 종합값을 보존하는 필드이고,
 * 정책 판단(R1, R1b, R1c)은 조건별 사실을 읽는다. conditions 가 없는 구형 입력에서만 R1 이 passed 를 본다.
 */
export const FactsSchema = z
  .looseObject({
    db: z.enum(["sqlite", "postgres", "mysql", "none"]).optional().describe("앱이 쓰는 DB. 소문자만. R5 가 읽는다. 관찰하지 못했으면 키를 생략한다 (none 은 'DB 없음' 을 확인했을 때만)"),
    writes_local_file: z.array(z.string()).optional().describe("앱이 쓰는 로컬 파일 경로 목록. R6 가 읽는다"),
    migration: MigrationReportSchema.optional(),
    conditions: ConditionFactsSchema.optional(),
    storage: z.array(StorageFactSchema).optional().describe("컨테이너 안에 남은 상태 목록 (테스트 파트 facts[] 원본의 kind, path, storage). 정책 판단에는 conditions[].mismatches[].related_kind 를 쓰고, 이 목록은 related_* 의 근거(같은 path·kind·storage 항목이 있어야 한다)와 설명용"),
  })
  .superRefine((facts, ctx) => {
    // R1c 는 replace 불일치의 related_kind 가 sqlite / local_upload / local_file 이면 차단하지 않고 R5 / R6 에 맡긴다.
    // 그런데 R5 는 facts.db, R6 는 facts.writes_local_file 을 읽으므로, related_* 가 그 두 사실로 뒷받침되지 않으면
    // 근거 없는 related_kind 만으로 세 규칙을 모두 피해 갈 수 있다. 그래서 related_* 는 facts.storage 의 조회값이어야 하고
    // (변환기는 원본 facts[] 에서 join 해 만드므로 항상 만족), kind 에 따라 R5 / R6 가 실제로 읽는 사실이 있어야 한다.
    // --handoff(변환기)와 --test(직접 입력) 어느 경로로 와도 같은 조건을 보장한다.
    const storage = facts.storage ?? [];
    const writes = facts.writes_local_file ?? [];
    for (const [i, c] of (facts.conditions ?? []).entries()) {
      for (const [j, m] of c.mismatches.entries()) {
        if (m.related_kind === undefined && m.related_storage === undefined) continue; // 힌트(related_fact)만 있거나 아무것도 없으면 R1c 가 차단한다
        const at = (key: keyof ConditionMismatch) => ["conditions", i, "mismatches", j, key];
        const missing = (["related_fact", "related_storage", "related_kind"] as const).find((k) => m[k] === undefined);
        if (missing !== undefined) {
          ctx.addIssue({ code: "custom", path: at(missing), message: "related_kind 나 related_storage 가 있으면 related_fact, related_storage, related_kind 가 모두 있어야 합니다 (저장 사실의 조회값)" });
          continue;
        }
        if (!storage.some((f) => f.path === m.related_fact && f.kind === m.related_kind && f.storage === m.related_storage)) {
          ctx.addIssue({ code: "custom", path: at("related_fact"), message: `facts.storage 에 path=${m.related_fact}, kind=${m.related_kind}, storage=${m.related_storage} 인 항목이 없습니다 (related_* 는 facts.storage 의 조회값이어야 합니다)` });
        }
        if (m.related_kind === SQLITE_KIND && facts.db !== SQLITE_KIND) {
          ctx.addIssue({ code: "custom", path: at("related_kind"), message: `related_kind 가 ${SQLITE_KIND} 이면 facts.db 도 ${SQLITE_KIND} 여야 합니다 (현재 ${facts.db ?? "(없음)"}). R1c 가 맡긴 불일치를 R5 가 처리할 수 있어야 합니다` });
        }
        if (LOCAL_FILE_KINDS.includes(m.related_kind!) && !writes.includes(m.related_fact!)) {
          ctx.addIssue({ code: "custom", path: at("related_fact"), message: `related_kind 가 ${m.related_kind} 이면 facts.writes_local_file 에 ${m.related_fact} 가 있어야 합니다. R1c 가 맡긴 불일치를 R6 가 처리할 수 있어야 합니다` });
        }
      }
    }
  })
  .describe("테스트 중 관찰한 사실. 정의된 키(db, writes_local_file, migration, conditions, storage)는 타입이 고정되고, 그 밖의 키는 자유");
export type Facts = z.infer<typeof FactsSchema>;
/** 정책 규칙이 참조해도 되는 facts 키 */
export const KNOWN_FACTS_KEYS: readonly string[] = Object.keys(FactsSchema.shape);

export const TestResultSchema = z
  .object({
    run_id: RunIdSchema,
    app: z.string().min(1).describe("앱 이름"),
    digest: DigestSchema,
    source_revision: SourceRevisionInputSchema,
    passed: z.boolean().describe("재생 테스트 통과 여부 (테스트 파트 원본의 종합값). facts.conditions 가 없으면 R1 이 이 값으로 차단하고, 있으면 조건별 사실로 판단한다"),
    match: z
      .object({
        total: z.number().int().nonnegative().describe("재생한 요청 수"),
        matched: z.number().int().nonnegative().describe("응답이 일치한 요청 수 (total 이하)"),
      })
      .describe("재생 결과 요약. facts.conditions 가 있으면 기준 조건 none 의 결과 (조건별 수치는 facts.conditions 에)"),
    failures: z.array(z.unknown()).default([]).describe("실패한 요청 목록. 형식은 테스트 파트가 정한다 (정책 엔진은 내용을 보지 않음)"),
    facts: FactsSchema.default({}),
  })
  .superRefine((test, ctx) => {
    // match 는 요약값이라 조건별 검사와 같은 fail-closed 를 둔다 (JSON Schema 에는 표현되지 않는 검사).
    // --handoff(변환기)는 none 조건의 결과를 match 에 넣으므로 항상 만족하고, --test(직접 입력)도 같은 조건을 보장한다.
    // passed 는 테스트 파트 원본의 종합값 보존용이라 none 과 비교하지 않는다.
    const { match } = test;
    if (match.matched > match.total) {
      ctx.addIssue({ code: "custom", path: ["match", "matched"], message: `match.matched(${match.matched})는 match.total(${match.total}) 이하여야 합니다` });
    }
    // conditions 가 있으면 match 는 기준 조건 none 의 결과와 같아야 한다 (none 이 없는 입력은 ConditionFactsSchema 가 이미 거부한다)
    const baseline = test.facts.conditions?.find((c) => c.name === BASELINE_CONDITION);
    if (baseline === undefined) return;
    if (match.total !== baseline.total) {
      ctx.addIssue({ code: "custom", path: ["match", "total"], message: `facts.conditions 가 있으면 match.total(${match.total})은 none 조건의 total(${baseline.total})과 같아야 합니다` });
    }
    if (match.matched !== baseline.matched) {
      ctx.addIssue({ code: "custom", path: ["match", "matched"], message: `facts.conditions 가 있으면 match.matched(${match.matched})는 none 조건의 matched(${baseline.matched})와 같아야 합니다` });
    }
  })
  .describe("테스트 파트가 만드는 테스트 판정 결과");
export type TestResult = z.infer<typeof TestResultSchema>;

// ---------------------------------------------------------------------------
// 입력 2: pii.json (개인정보 후보. 지금은 가짜 파일, 나중에 AI 판정 결과)
// ---------------------------------------------------------------------------
/** 후보를 누가 판정했는지. 정책 엔진은 이 값을 쓰지 않는다 (감사·디버깅용). */
export const PiiSourceSchema = z.enum(["heuristic", "llm", "replay"]).describe("누가 판정했는지. heuristic=규칙, llm=AI, replay=저장된 AI 응답 재생");
export type PiiSource = z.infer<typeof PiiSourceSchema>;

export const PiiCandidateSchema = z
  .object({
    table: z.string().min(1).describe("테이블 또는 모델 이름"),
    column: z.string().min(1).describe("칼럼 이름"),
    kind: z.string().min(1).describe("개인정보 종류 (phone, email, address, birthdate, national_id ...)"),
    evidence: z.string().min(1).describe("근거 위치 '파일:줄'. 여러 개면 ', ' 로 잇는다. plan.json 의 reason 에 그대로 들어간다"),
    confident: z.boolean().describe("확신 여부. false 면 정책 엔진이 사람 승인(needs_approval)으로 보낸다"),
    source: PiiSourceSchema.optional(),
  })
  .describe("개인정보 후보 칼럼 하나");
export type PiiCandidate = z.infer<typeof PiiCandidateSchema>;

export const PiiReportSchema = z
  .object({
    run_id: RunIdSchema,
    pii: z.array(PiiCandidateSchema).default([]).describe("개인정보 후보 목록. 없으면 빈 배열"),
  })
  .describe("개인정보 판정 모듈이 만드는 개인정보 후보 보고");
export type PiiReport = z.infer<typeof PiiReportSchema>;

// ---------------------------------------------------------------------------
// 입력 3: policy.yaml
//
// 조건(if) 은 작은 DSL 로 표현한다. 엔진은 규칙 "내용" 을 모르고 이 DSL 만 해석한다.
//   { path, eq / ne / in / gt / lt / exists }   값 비교
//   { path, eq_path / ne_path }                  두 필드 비교 (예: run_id 불일치)
//   { some, where? }                             배열에 조건을 만족하는 원소가 하나라도 있는가
//   { all: [...] } { any: [...] } { not: ... }   논리 결합
//
// path 는 점 표기. 루트 컨텍스트는 { test, pii } 이며, `some ... where` 안에서는
// 배열 원소가 기준이 되고 `$.` 접두어로 루트에 접근한다.
// ---------------------------------------------------------------------------
const JsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonPrimitive = z.infer<typeof JsonPrimitive>;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { some: string; where?: Condition }
  | { path: string; eq: JsonPrimitive }
  | { path: string; ne: JsonPrimitive }
  | { path: string; in: JsonPrimitive[] }
  | { path: string; gt: number }
  | { path: string; lt: number }
  | { path: string; exists: boolean }
  | { path: string; starts_with: string }
  | { path: string; matches: string; flags?: string }
  | { path: string; eq_path: string }
  | { path: string; ne_path: string };

/** { path, matches, flags? }: 정규식과 플래그(i, m, s, u 등)가 함께 올바른지 검사한다 */
const MatchesCondition = z
  .strictObject({
    path: z.string().min(1),
    matches: z.string().min(1),
    flags: z.string().regex(/^[gimsuy]*$/, "정규식 플래그는 g i m s u y 만 쓸 수 있습니다").optional(),
  })
  .refine(
    (c) => {
      try {
        new RegExp(c.matches, c.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: "올바른 정규식이 아닙니다", path: ["matches"] },
  );

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema }),
    z.strictObject({ some: z.string().min(1), where: ConditionSchema.optional() }),
    z.strictObject({ path: z.string().min(1), eq: JsonPrimitive }),
    z.strictObject({ path: z.string().min(1), ne: JsonPrimitive }),
    z.strictObject({ path: z.string().min(1), in: z.array(JsonPrimitive) }),
    z.strictObject({ path: z.string().min(1), gt: z.number() }),
    z.strictObject({ path: z.string().min(1), lt: z.number() }),
    z.strictObject({ path: z.string().min(1), exists: z.boolean() }),
    z.strictObject({ path: z.string().min(1), starts_with: z.string().min(1) }),
    MatchesCondition,
    z.strictObject({ path: z.string().min(1), eq_path: z.string().min(1) }),
    z.strictObject({ path: z.string().min(1), ne_path: z.string().min(1) }),
  ]),
);

// ---------------------------------------------------------------------------
// 규정집 문구 (reason, hint): 문자열(ko) 또는 { ko, ja }. 엔진은 항상 { ko, ja? } 로 본다.
// 결정서에는 ko 문자열을 그대로 싣고, ja 가 있으면 *_i18n: { ja } 를 함께 싣는다.
// ---------------------------------------------------------------------------
export interface I18nText {
  ko: string;
  ja?: string;
}
export const I18nTextSchema = z
  .union([z.string().min(1), z.strictObject({ ko: z.string().min(1), ja: z.string().min(1).optional() })])
  .transform((v): I18nText => (typeof v === "string" ? { ko: v } : v));

/** 결정서에 실리는 번역 묶음. ko 는 본문 필드에 있으므로 여기엔 ja 만 */
export const I18nExtraSchema = z.strictObject({ ja: z.string().describe("일본어 문구") }).describe("ko 외 언어의 문구. 정책에 적혀 있을 때만");

// ---------------------------------------------------------------------------
// 해결 조건 (requires): "이 규칙에 걸린 이유를 없애려면 무엇이 필요한가"
// policy.yaml 에서는 문자열(id 만) 또는 { id, hint } 로 적는다. 엔진은 항상 객체로 본다.
// ---------------------------------------------------------------------------
export const RequirementSchema = z.strictObject({
  id: z.string().min(1).describe("해결 조건 id (예: managed_db, fix_tests)"),
  hint: I18nTextSchema.optional().describe("사람이 읽는 설명. 무엇을 하면 되는지. 위치는 적지 않는다 (allowed_targets 가 정한다)"),
});
export type Requirement = z.infer<typeof RequirementSchema>;

const RequiresSchema = z
  .array(z.union([z.string().min(1), RequirementSchema]))
  .transform((items): Requirement[] => items.map((item) => (typeof item === "string" ? { id: item } : item)));

export const DecisionSchema = z
  .enum(["allow", "block", "needs_approval"])
  .describe("allow=배포 진행, block=배포 안 함, needs_approval=사람 승인 후 진행");
export type Decision = z.infer<typeof DecisionSchema>;

/** 규칙이 걸렸을 때 적용되는 효과. 비어 있는 키는 "바꾸지 않음". */
export const EffectSchema = z.strictObject({
  decision: z.enum(["block", "needs_approval"]).optional(),
  targets: z.array(z.string().min(1)).min(1).optional(),
  failover_allowed: z.boolean().optional(),
  /** 해결 조건. block / needs_approval 을 내는 규칙은 최소 1개 있어야 한다 (PolicySchema 가 검사) */
  requires: RequiresSchema.optional(),
});
export type Effect = z.infer<typeof EffectSchema>;

export const RuleSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  if: ConditionSchema,
  then: EffectSchema,
  /** 사람이 읽는 근거. 문자열(ko) 또는 { ko, ja }. {경로} 로 값을 넣는다 */
  reason: I18nTextSchema,
  /**
   * true 면 이 규칙이 걸렸을 때 뒤 규칙을 평가하지 않는다 (예: 입력이 섞여 뒤 판단이 무의미할 때).
   * 기본은 false: block 이 나와도 끝까지 평가해 targets 좁히기와 해결 조건을 모두 모은다.
   */
  halt: z.boolean().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

// ---------------------------------------------------------------------------
// policy.yaml 의 rollback 섹션 (정책 인식 롤백). 조건 문법은 배포 규칙과 같다.
// 컨텍스트는 { request: rollback_request.json }
// ---------------------------------------------------------------------------
/**
 * keep_stable      : 컷오버 전 실패 등. 정상 버전(stable)이 계속 트래픽을 받는다
 * rollback         : 정상 버전(stable)으로 되돌린다
 * manual_recovery  : 자동으로 되돌릴 수 없다. 사람이 복구한다
 */
export const RollbackDecisionSchema = z
  .enum(["keep_stable", "rollback", "manual_recovery"])
  .describe("keep_stable=정상 버전이 계속 트래픽을 받음, rollback=정상 버전으로 되돌림, manual_recovery=자동으로 못 되돌림 (사람이 복구)");
export type RollbackDecision = z.infer<typeof RollbackDecisionSchema>;

export const RollbackEffectSchema = z.strictObject({
  decision: RollbackDecisionSchema.optional(),
  /** 대상을 좁힌다 (정상 버전의 대상과 교집합) */
  targets: z.array(z.string().min(1)).min(1).optional(),
  /** false 로 정하면 뒤에서 되돌릴 수 없다 */
  failover_allowed: z.boolean().optional(),
  /** 해결 조건. manual_recovery 를 내는 규칙은 최소 1개 있어야 한다 */
  requires: RequiresSchema.optional(),
});

export const RollbackRuleSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  if: ConditionSchema,
  then: RollbackEffectSchema,
  reason: I18nTextSchema,
  /** true 면 걸렸을 때 즉시 멈춘다. keep_stable 은 halt 와 무관하게 항상 즉시 멈춘다 */
  halt: z.boolean().optional(),
});
export type RollbackRule = z.infer<typeof RollbackRuleSchema>;

export const RollbackPolicySchema = z.strictObject({
  rules: z.array(RollbackRuleSchema),
  default: z.strictObject({
    decision: RollbackDecisionSchema,
    /** 어떤 규칙도 failover 를 정하지 않았을 때의 값 (최종 targets 에 onprem·cloud_run 이 모두 있어야 유효) */
    failover_allowed: z.boolean(),
    reason: I18nTextSchema.default({ ko: "기본 롤백 정책 적용" }),
  }),
});
export type RollbackPolicy = z.infer<typeof RollbackPolicySchema>;

export const PolicySchema = z
  .strictObject({
    version: z.literal(1),
    /** 이 정책이 아는 배포 대상 전체. 규칙과 default 의 targets 는 모두 여기 있어야 한다. */
    known_targets: z.array(z.string().min(1)).min(1),
    rules: z.array(RuleSchema),
    default: z.strictObject({
      targets: z.array(z.string().min(1)).min(1),
      failover_allowed: z.boolean(),
      reason: I18nTextSchema.default({ ko: "기본 정책 적용" }),
    }),
    /** 롤백 판단 규칙. 없으면 롤백 CLI 가 에러로 멈춘다 */
    rollback: RollbackPolicySchema.optional(),
  })
  .superRefine((policy, ctx) => {
    const known = new Set(policy.known_targets);
    const checkTargets = (targets: readonly string[] | undefined, path: (string | number)[], where: string) => {
      targets?.forEach((t, j) => {
        if (!known.has(t)) {
          ctx.addIssue({ code: "custom", path: [...path, j], message: `알 수 없는 배포 대상: ${t} (${where})` });
        }
      });
    };
    type RuleLike = { id: string; then: { targets?: readonly string[]; decision?: string; requires?: readonly Requirement[] } };
    const checkRules = (rules: ReadonlyArray<RuleLike>, basePath: string[], label: string, decisionsNeedingRequires: readonly string[]) => {
      const seen = new Set<string>();
      rules.forEach((rule, i) => {
        if (rule.id === "default") {
          ctx.addIssue({ code: "custom", path: [...basePath, i, "id"], message: "규칙 id 'default' 는 예약어입니다" });
        }
        if (seen.has(rule.id)) {
          ctx.addIssue({ code: "custom", path: [...basePath, i, "id"], message: `규칙 id 중복: ${rule.id}` });
        }
        seen.add(rule.id);
        checkTargets(rule.then.targets, [...basePath, i, "then", "targets"], `${label}규칙 ${rule.id}`);
        // 멈추는 결정(차단·승인 필요·수동 복구)을 내는 규칙은 "무엇을 하면 풀리는지" 를 반드시 적어야 한다
        if (rule.then.decision !== undefined && decisionsNeedingRequires.includes(rule.then.decision) && !(rule.then.requires && rule.then.requires.length > 0)) {
          ctx.addIssue({
            code: "custom",
            path: [...basePath, i, "then", "requires"],
            message: `${label}규칙 ${rule.id}: decision '${rule.then.decision}' 을(를) 내는 규칙은 requires(해결 조건)가 최소 1개 있어야 합니다`,
          });
        }
      });
    };

    checkRules(policy.rules, ["rules"], "", ["block", "needs_approval"]);
    checkTargets(policy.default.targets, ["default", "targets"], "default");
    if (policy.rollback) checkRules(policy.rollback.rules, ["rollback", "rules"], "롤백 ", ["manual_recovery"]);
  });
export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// 출력: plan.json
// ---------------------------------------------------------------------------
export const RuleResultSchema = z
  .strictObject({
    id: z.string().describe("policy.yaml 의 규칙 id. 'default' 는 기본 정책이 쓰였다는 뜻"),
    result: z
      .enum(["matched", "not_matched", "matched_after_block"])
      .describe("규칙이 걸렸는지. matched_after_block = 이미 block(롤백은 manual_recovery)이 정해진 뒤 걸림: decision 은 못 바꾸고 targets 좁히기와 해결 조건만 반영됨"),
    reason: z.string().optional().describe("걸린 규칙의 사람이 읽는 근거 (ko). matched / matched_after_block 일 때만 있다"),
    reason_i18n: I18nExtraSchema.optional().describe("reason 의 다른 언어 문구. 정책에 ja 가 적혀 있을 때만"),
  })
  .describe("평가된 규칙 하나의 결과");
export type RuleResult = z.infer<typeof RuleResultSchema>;

const PlanHashSchema = z.string().regex(/^[0-9a-f]{64}$/).describe("입력과 정책과 결과를 정규화해 sha256 한 값. 같은 입력이면 항상 같다");

/** plan 에 실리는 해결 조건. 걸린 규칙들의 requires 를 id 로 합치고 정렬한 것 */
export const PlanRequirementSchema = z
  .strictObject({
    id: z.string().describe("해결 조건 id (예: managed_db, fix_tests)"),
    hint: z.string().optional().describe("사람이 읽는 설명 (ko). 정책에 적혀 있을 때만"),
    hint_i18n: I18nExtraSchema.optional().describe("hint 의 다른 언어 문구. 정책에 ja 가 적혀 있을 때만"),
    rule_id: z.string().describe("이 조건을 처음 요구한 규칙 id"),
    allowed_targets: z
      .array(z.string())
      .describe(
        "이 해결 조건과 연결된 정책 위반이 해소됐다고 가정했을 때, 나머지 정책 제약상 가능한 배포 위치. 한 규칙이 해결 조건을 여러 개 요구하면 모두 충족해야 한다. 수정 후에는 새 버전으로 전체 정책을 다시 평가한다. 나머지 제약끼리 충돌하면 빈 배열",
      ),
  })
  .describe("해결 조건 하나");
export type PlanRequirement = z.infer<typeof PlanRequirementSchema>;
const PlanRequiresSchema = z
  .array(PlanRequirementSchema)
  .optional()
  .describe("걸린 규칙들의 해결 조건 (id 로 합치고 id 순 정렬). block / needs_approval / manual_recovery 면 최소 1개. 하나도 없으면 필드가 없다");

export const PlanSchema = z
  .strictObject({
    run_id: RunIdSchema,
    app: z.string().describe("앱 이름 (test_result 에서 그대로)"),
    digest: DigestSchema,
    source_revision: SourceRevisionSchema.optional().describe("테스트한 소스의 커밋 SHA (test_result 에서 그대로). 입력에 있을 때만"),
    decision: DecisionSchema,
    targets: z.array(z.string()).describe("배포할 대상 (known_targets 의 부분집합). block 이면 빈 배열"),
    failover_allowed: z.boolean().describe("온프레 장애 시 Cloud Run 으로 전환해도 되는지. onprem 과 cloud_run 이 모두 있을 때만 true 가능"),
    requires: PlanRequiresSchema,
    rules: z.array(RuleResultSchema).describe("평가된 모든 규칙과 결과. block 이후에도 해결 조건과 대상 제한을 모으기 위해 끝까지 평가하며, 그때 걸린 규칙은 matched_after_block 으로 기록 (halt 규칙이 걸리면 즉시 멈춤)"),
    plan_hash: PlanHashSchema,
  })
  .describe("정책 엔진이 만드는 배포 계획. 서명 파트와 배포 파트가 읽는다");
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// 롤백 입력: rollback_request.json / 출력: rollback_plan.json
// ---------------------------------------------------------------------------
export const RollbackRequestSchema = z
  .object({
    run_id: RunIdSchema,
    app: z.string().min(1).describe("앱 이름"),
    stage: z.enum(["before_cutover", "after_cutover"]).describe("before_cutover=후보로 트래픽을 넘기기 전 실패, after_cutover=넘긴 뒤 실패"),
    source_revision: SourceRevisionInputSchema,
    candidate: z
      .object({ digest: DigestSchema, targets: z.array(z.string().min(1)).describe("후보가 배포된 대상") })
      .describe("이번 배포 후보 (문제가 난 버전)"),
    stable: z
      .object({ digest: DigestSchema, targets: z.array(z.string().min(1)).min(1).describe("정상 버전이 배포돼 있는 대상 (되돌아갈 곳의 출발점)") })
      .describe("이번 배포 전 정상 버전 (되돌아갈 곳)"),
    state: z
      .object({
        writes_since_cutover: z.boolean().describe("컷오버 후 데이터 쓰기가 있었는지"),
        pii_written_onprem: z.boolean().describe("컷오버 후 온프레에 개인정보가 쓰였는지"),
        db_migration_backward_compatible: z.boolean().describe("DB 마이그레이션이 정상 버전과 호환되는지. false 면 자동 롤백 차단"),
      })
      .describe("배포 파트가 관찰한 상태"),
  })
  .describe("배포 파트가 만드는 롤백 판단 요청");
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

export const RollbackPlanSchema = z
  .strictObject({
    run_id: RunIdSchema,
    app: z.string().describe("앱 이름 (요청에서 그대로)"),
    source_revision: SourceRevisionSchema.optional().describe("배포 후보의 커밋 SHA (rollback_request 에서 그대로). 요청에 있을 때만"),
    decision: RollbackDecisionSchema,
    serve_digest: DigestSchema.nullable().describe("결정 후 트래픽을 받아야 할 버전. keep_stable / rollback → stable.digest, manual_recovery → null"),
    targets: z.array(z.string()).describe("keep_stable / rollback → stable.targets 에서 좁힌 결과, manual_recovery → []"),
    failover_allowed: z.boolean().describe("온프레 장애 시 Cloud Run 전환 허용 여부. false 가 이기고, onprem 과 cloud_run 이 모두 있을 때만 true 가능"),
    requires: PlanRequiresSchema,
    rules: z.array(RuleResultSchema).describe("평가된 모든 롤백 규칙과 결과. manual_recovery 이후에도 해결 조건과 대상 제한을 모으기 위해 끝까지 평가하며, 그때 걸린 규칙은 matched_after_block 으로 기록 (keep_stable 과 halt 규칙은 즉시 멈춤)"),
    plan_hash: PlanHashSchema,
  })
  .describe("롤백 판단 모듈이 만드는 롤백 계획. 배포 파트가 실행한다");
export type RollbackPlan = z.infer<typeof RollbackPlanSchema>;

// ---------------------------------------------------------------------------
// 결정 기록: decisions.jsonl 의 한 줄. kind 로 배포/롤백을 구분한다
// ---------------------------------------------------------------------------
const LogTimeSchema = z.string().describe("결정 시각 (ISO 8601). CLI 가 붙인다. 엔진은 시간을 쓰지 않는다");
const RuleIdsSchema = z.array(z.string()).describe("걸린 규칙 id (plan 의 rules 중 matched 와 matched_after_block, 구분 없이 id 만)");

export const DeployDecisionLogSchema = z
  .strictObject({
    kind: z.literal("deploy").describe("배포 결정"),
    time: LogTimeSchema,
    run_id: RunIdSchema,
    digest: DigestSchema.describe("결정한 이미지의 digest (plan.digest)"),
    source_revision: SourceRevisionSchema.optional().describe("plan.source_revision. plan 에 있을 때만"),
    decision: DecisionSchema,
    targets: z.array(z.string()).describe("plan.targets"),
    rule_ids: RuleIdsSchema,
    plan_hash: PlanHashSchema.describe("plan.plan_hash"),
  })
  .describe("배포 결정 한 건");
export const RollbackDecisionLogSchema = z
  .strictObject({
    kind: z.literal("rollback").describe("롤백 결정"),
    time: LogTimeSchema,
    run_id: RunIdSchema,
    digest: DigestSchema.describe("문제가 난 배포 후보(candidate)의 digest"),
    source_revision: SourceRevisionSchema.optional().describe("rollback_plan.source_revision. 요청에 있을 때만"),
    serve_digest: DigestSchema.nullable().describe("결정 후 트래픽을 받을 버전. manual_recovery 면 null"),
    decision: RollbackDecisionSchema,
    targets: z.array(z.string()).describe("rollback_plan.targets"),
    failover_allowed: z.boolean().describe("rollback_plan.failover_allowed"),
    rule_ids: RuleIdsSchema,
    plan_hash: PlanHashSchema.describe("rollback_plan.plan_hash"),
  })
  .describe("롤백 결정 한 건");
export const DecisionLogSchema = z
  .discriminatedUnion("kind", [DeployDecisionLogSchema, RollbackDecisionLogSchema])
  .describe("decisions.jsonl 의 한 줄. kind 로 배포/롤백을 구분한다. 추가만 하고 수정하지 않는다");
export type DecisionLog = z.infer<typeof DecisionLogSchema>;
export type DeployDecisionLog = z.infer<typeof DeployDecisionLogSchema>;
export type RollbackDecisionLog = z.infer<typeof RollbackDecisionLogSchema>;
