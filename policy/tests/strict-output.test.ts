/**
 * 출력 스키마는 추가 필드를 거부한다 (zod 와 JSON Schema 둘 다). 입력 스키마는 지금처럼 허용한다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { CONTRACTS, toJsonSchema } from "../src/contracts.js";
import { decide, matchedRuleIds } from "../src/engine.js";
import { decideRollback } from "../src/rollback/engine.js";
import {
  DecisionLogSchema,
  PiiReportSchema,
  PlanRequirementSchema,
  PlanSchema,
  PolicySchema,
  RollbackPlanSchema,
  RollbackRequestSchema,
  RuleResultSchema,
  TestResultSchema,
} from "../src/schema.js";

const ROOT = join(import.meta.dirname, "..");
const policy = PolicySchema.parse(parseYaml(readFileSync(join(ROOT, "policy.yaml"), "utf8")));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const plan = decide(TestResultSchema.parse(readJson("fixtures/02-block-test-failed/test_result.json")), PiiReportSchema.parse(readJson("fixtures/02-block-test-failed/pii.json")), policy);
const rollback = decideRollback(RollbackRequestSchema.parse(readJson("fixtures/rollback/06-pii-and-db-incompatible.json")), policy);
const deployLog = { kind: "deploy" as const, time: "2026-09-30T00:00:00.000Z", run_id: plan.run_id, digest: plan.digest, decision: plan.decision, targets: plan.targets, rule_ids: matchedRuleIds(plan.rules), plan_hash: plan.plan_hash };
const rollbackLog = {
  kind: "rollback" as const,
  time: "2026-09-30T00:00:00.000Z",
  run_id: rollback.run_id,
  digest: `sha256:${"6".repeat(64)}`,
  serve_digest: rollback.serve_digest,
  decision: rollback.decision,
  targets: rollback.targets,
  failover_allowed: rollback.failover_allowed,
  rule_ids: matchedRuleIds(rollback.rules),
  plan_hash: rollback.plan_hash,
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map(CONTRACTS.map((c) => [c.name, ajv.compile(toJsonSchema(c))] as const));

describe("출력 스키마는 추가 필드를 거부한다 (zod + JSON Schema)", () => {
  const cases: Array<[string, unknown]> = [
    ["Plan", plan],
    ["RollbackPlan", rollback],
    ["DecisionLog", deployLog],
    ["DecisionLog", rollbackLog],
  ];

  it("원본은 둘 다 통과한다", () => {
    for (const [name, value] of cases) {
      expect(validators.get(name)!(value), name).toBe(true);
    }
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(RollbackPlanSchema.safeParse(rollback).success).toBe(true);
    expect(DecisionLogSchema.safeParse(deployLog).success).toBe(true);
    expect(DecisionLogSchema.safeParse(rollbackLog).success).toBe(true);
  });

  it("최상위에 extra_field 를 넣으면 거부", () => {
    const zod = { Plan: PlanSchema, RollbackPlan: RollbackPlanSchema, DecisionLog: DecisionLogSchema } as const;
    for (const [name, value] of cases) {
      const extra = { ...(value as object), extra_field: 1 };
      expect(validators.get(name)!(extra), `${name} json-schema`).toBe(false);
      expect(zod[name as keyof typeof zod].safeParse(extra).success, `${name} zod`).toBe(false);
    }
  });

  it("하위 객체(rules[], requires[], *_i18n)에 extra_field 를 넣어도 거부", () => {
    const rule = plan.rules.find((r) => r.result === "matched")!;
    const req = plan.requires![0]!;

    expect(RuleResultSchema.safeParse({ ...rule, extra_field: 1 }).success).toBe(false);
    expect(RuleResultSchema.safeParse({ ...rule, reason_i18n: { ...rule.reason_i18n, extra_field: 1 } }).success).toBe(false);
    expect(PlanRequirementSchema.safeParse({ ...req, extra_field: 1 }).success).toBe(false);
    expect(PlanRequirementSchema.safeParse({ ...req, hint_i18n: { ...req.hint_i18n, extra_field: 1 } }).success).toBe(false);

    const withBadRule = { ...plan, rules: [{ ...rule, extra_field: 1 }, ...plan.rules.slice(1)] };
    expect(PlanSchema.safeParse(withBadRule).success).toBe(false);
    expect(validators.get("Plan")!(withBadRule)).toBe(false);

    const withBadReq = { ...plan, requires: [{ ...req, extra_field: 1 }] };
    expect(PlanSchema.safeParse(withBadReq).success).toBe(false);
    expect(validators.get("Plan")!(withBadReq)).toBe(false);

    const rbRule = rollback.rules.find((r) => r.result === "matched")!;
    const withBadRbRule = { ...rollback, rules: [{ ...rbRule, extra_field: 1 }] };
    expect(RollbackPlanSchema.safeParse(withBadRbRule).success).toBe(false);
    expect(validators.get("RollbackPlan")!(withBadRbRule)).toBe(false);
  });

  it("입력 스키마는 지금처럼 모르는 필드를 허용한다", () => {
    const test = readJson("fixtures/01-allow/test_result.json") as object;
    expect(TestResultSchema.safeParse({ ...test, extra_field: 1 }).success).toBe(true);
    expect(validators.get("TestResult")!({ ...test, extra_field: 1 })).toBe(true);
    const pii = readJson("fixtures/03-pii-confident/pii.json") as { pii: object[] };
    expect(PiiReportSchema.safeParse({ ...pii, extra_field: 1, pii: [{ ...pii.pii[0], extra_field: 1 }] }).success).toBe(true);
    const req = readJson("fixtures/rollback/05-default.json") as object;
    expect(RollbackRequestSchema.safeParse({ ...req, extra_field: 1 }).success).toBe(true);
    expect(validators.get("RollbackRequest")!({ ...req, extra_field: 1 })).toBe(true);
  });

  it("JSON Schema 에서 출력 객체는 additionalProperties: false", () => {
    for (const name of ["Plan", "RollbackPlan"]) {
      const schema = toJsonSchema(CONTRACTS.find((c) => c.name === name)!) as Record<string, unknown>;
      expect(schema.additionalProperties, name).toBe(false);
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect((props.rules!.items as Record<string, unknown>).additionalProperties).toBe(false);
      expect((props.requires!.items as Record<string, unknown>).additionalProperties).toBe(false);
    }
    const log = toJsonSchema(CONTRACTS.find((c) => c.name === "DecisionLog")!) as { oneOf: Array<Record<string, unknown>> };
    for (const variant of log.oneOf) expect(variant.additionalProperties).toBe(false);
  });
});
