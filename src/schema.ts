/**
 * 모듈 간 주고받는 JSON 파일과 policy.yaml 의 zod 스키마.
 * 여기서 타입도 함께 내보내므로 engine.ts / cli.ts 는 이 파일만 참조한다.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 입력 1: test_result.json (테스트 파트가 만듦)
// ---------------------------------------------------------------------------
export const TestResultSchema = z.object({
  run_id: z.string().min(1),
  app: z.string().min(1),
  digest: z.string().regex(/^sha256:[A-Za-z0-9]+$/, "digest 는 'sha256:<hex>' 형식이어야 합니다"),
  passed: z.boolean(),
  match: z.object({
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
  }),
  failures: z.array(z.unknown()).default([]),
  facts: z.record(z.string(), z.unknown()).default({}),
});
export type TestResult = z.infer<typeof TestResultSchema>;

// ---------------------------------------------------------------------------
// 입력 2: pii.json (개인정보 후보. 지금은 가짜 파일, 나중에 AI 판정 결과)
// ---------------------------------------------------------------------------
/** 후보를 누가 판정했는지. 정책 엔진은 이 값을 쓰지 않는다 (감사·디버깅용). */
export const PiiSourceSchema = z.enum(["heuristic", "llm", "replay"]);
export type PiiSource = z.infer<typeof PiiSourceSchema>;

export const PiiCandidateSchema = z.object({
  table: z.string().min(1),
  column: z.string().min(1),
  kind: z.string().min(1),
  evidence: z.string().min(1),
  confident: z.boolean(),
  source: PiiSourceSchema.optional(),
});
export type PiiCandidate = z.infer<typeof PiiCandidateSchema>;

export const PiiReportSchema = z.object({
  run_id: z.string().min(1),
  pii: z.array(PiiCandidateSchema).default([]),
});
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
  | { path: string; eq_path: string }
  | { path: string; ne_path: string };

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
    z.strictObject({ path: z.string().min(1), eq_path: z.string().min(1) }),
    z.strictObject({ path: z.string().min(1), ne_path: z.string().min(1) }),
  ]),
);

export const DecisionSchema = z.enum(["allow", "block", "needs_approval"]);
export type Decision = z.infer<typeof DecisionSchema>;

/** 규칙이 걸렸을 때 적용되는 효과. 비어 있는 키는 "바꾸지 않음". */
export const EffectSchema = z.strictObject({
  decision: z.enum(["block", "needs_approval"]).optional(),
  targets: z.array(z.string().min(1)).min(1).optional(),
  failover_allowed: z.boolean().optional(),
  /** 이 규칙이 걸린 이유를 없애려면 무엇이 필요한지 (예: managed_db). 다음 단계(AI 수정)가 읽는다 */
  requires: z.array(z.string().min(1)).optional(),
});
export type Effect = z.infer<typeof EffectSchema>;

export const RuleSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  if: ConditionSchema,
  then: EffectSchema,
  reason: z.string().min(1),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicySchema = z
  .strictObject({
    version: z.literal(1),
    /** 이 정책이 아는 배포 대상 전체. 규칙과 default 의 targets 는 모두 여기 있어야 한다. */
    known_targets: z.array(z.string().min(1)).min(1),
    rules: z.array(RuleSchema),
    default: z.strictObject({
      targets: z.array(z.string().min(1)).min(1),
      failover_allowed: z.boolean(),
      reason: z.string().min(1).default("기본 정책 적용"),
    }),
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

    const seen = new Set<string>();
    policy.rules.forEach((rule, i) => {
      if (rule.id === "default") {
        ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: "규칙 id 'default' 는 예약어입니다" });
      }
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `규칙 id 중복: ${rule.id}` });
      }
      seen.add(rule.id);
      checkTargets(rule.then.targets, ["rules", i, "then", "targets"], `규칙 ${rule.id}`);
    });
    checkTargets(policy.default.targets, ["default", "targets"], "default");
  });
export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// 출력: plan.json
// ---------------------------------------------------------------------------
export const RuleResultSchema = z.object({
  id: z.string(),
  result: z.enum(["matched", "not_matched"]),
  reason: z.string().optional(),
});
export type RuleResult = z.infer<typeof RuleResultSchema>;

export const PlanSchema = z.object({
  run_id: z.string(),
  app: z.string(),
  digest: z.string(),
  decision: DecisionSchema,
  targets: z.array(z.string()),
  failover_allowed: z.boolean(),
  /** 걸린 규칙들의 requires 를 모은 것 (중복 제거, 정렬). 하나도 없으면 필드 자체가 없다 */
  requires: z.array(z.string()).optional(),
  rules: z.array(RuleResultSchema),
  plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// 결정 기록: decisions.jsonl 의 한 줄
// ---------------------------------------------------------------------------
export const DecisionLogSchema = z.object({
  time: z.string(),
  run_id: z.string(),
  digest: z.string(),
  decision: DecisionSchema,
  targets: z.array(z.string()),
  rule_ids: z.array(z.string()),
  plan_hash: z.string(),
});
export type DecisionLog = z.infer<typeof DecisionLogSchema>;
