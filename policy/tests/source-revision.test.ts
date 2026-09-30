/**
 * source_revision(커밋 SHA): test_result → plan → 결정 기록, rollback_request → rollback_plan → 결정 기록으로
 * 값이 있을 때만 그대로 전달되고, 없으면 필드 자체가 없어 기존 plan_hash 가 바뀌지 않는다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { CONTRACTS, toJsonSchema } from "../src/contracts.js";
import { decide } from "../src/engine.js";
import { explainPlan, explainRollbackPlan, shortRevision } from "../src/explainer.js";
import { decideRollback } from "../src/rollback/engine.js";
import {
  DecisionLogSchema,
  PiiReportSchema,
  PlanSchema,
  PolicySchema,
  RollbackPlanSchema,
  RollbackRequestSchema,
  SOURCE_REVISION_UNKNOWN,
  SourceRevisionSchema,
  TestResultSchema,
  type PiiReport,
  type TestResult,
} from "../src/schema.js";
import { applySourceRevision, runStage } from "../src/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const POLICY = join(ROOT, "policy.yaml");
const policy = PolicySchema.parse(parseYaml(readFileSync(POLICY, "utf8")));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const FULL = "9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6"; // fixtures/03-pii-confident 와 fixtures/rollback/03-pii-onprem 의 값
const OTHER = "0123456789abcdef0123456789abcdef01234567";

function loadFixture(name: string): { raw: Record<string, unknown>; test: TestResult; pii: PiiReport } {
  const raw = readJson(`fixtures/${name}/test_result.json`) as Record<string, unknown>;
  return { raw, test: TestResultSchema.parse(raw), pii: PiiReportSchema.parse(readJson(`fixtures/${name}/pii.json`)) };
}
/** source_revision 을 뺀 test_result */
function without(test: TestResult): TestResult {
  const { source_revision: _omit, ...rest } = test;
  return rest;
}

const tempDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-engine-revision-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function runCli(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [TSX, join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const lastLog = (path: string) => JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!) as Record<string, unknown>;

describe("형식: 소문자 hex 7~40자, \"unknown\" 은 없는 것", () => {
  it("SourceRevisionSchema 는 7~40자 소문자 hex 만 받는다", () => {
    for (const ok of ["abcdef0", "9f8e7d6c5b4a", FULL]) expect(SourceRevisionSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["abcdef", "g".repeat(7), FULL.toUpperCase(), `${FULL}0`, "", SOURCE_REVISION_UNKNOWN, "sha256:abcdef0"]) {
      expect(SourceRevisionSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("test_result: 없어도 되고, 있으면 그대로, \"unknown\" 이면 없는 것으로 (필드 자체가 사라진다)", () => {
    const { raw } = loadFixture("01-allow");
    expect(TestResultSchema.parse(raw).source_revision).toBeUndefined();
    expect(TestResultSchema.parse({ ...raw, source_revision: FULL }).source_revision).toBe(FULL);
    expect(TestResultSchema.parse({ ...raw, source_revision: "abcdef0" }).source_revision).toBe("abcdef0");
    const unknown = TestResultSchema.parse({ ...raw, source_revision: SOURCE_REVISION_UNKNOWN });
    expect(unknown.source_revision).toBeUndefined();
    expect(JSON.stringify(unknown)).not.toContain("source_revision");
    for (const bad of ["abc", "ABCDEF0", "Unknown", 123, null]) {
      expect(TestResultSchema.safeParse({ ...raw, source_revision: bad }).success, String(bad)).toBe(false);
    }
  });

  it("fixtures: 03 은 전체 SHA, 04 는 \"unknown\", 나머지는 없음", () => {
    expect(loadFixture("03-pii-confident").test.source_revision).toBe(FULL);
    expect(loadFixture("04-pii-unconfident").raw.source_revision).toBe(SOURCE_REVISION_UNKNOWN);
    expect(loadFixture("04-pii-unconfident").test.source_revision).toBeUndefined();
    expect(loadFixture("01-allow").test.source_revision).toBeUndefined();
    expect(loadFixture("02-block-test-failed").test.source_revision).toBeUndefined();
  });

  it("rollback_request 도 같은 형식", () => {
    const raw = readJson("fixtures/rollback/05-default.json") as Record<string, unknown>;
    expect(RollbackRequestSchema.parse(raw).source_revision).toBeUndefined();
    expect(RollbackRequestSchema.parse({ ...raw, source_revision: FULL }).source_revision).toBe(FULL);
    expect(RollbackRequestSchema.parse({ ...raw, source_revision: SOURCE_REVISION_UNKNOWN }).source_revision).toBeUndefined();
    expect(RollbackRequestSchema.safeParse({ ...raw, source_revision: "ABC" }).success).toBe(false);
    expect(RollbackRequestSchema.parse(readJson("fixtures/rollback/03-pii-onprem.json")).source_revision).toBe(FULL);
  });

  it("JSON Schema(contracts) 도 같은 판정: 입력은 hex 또는 \"unknown\", 출력은 hex 만 (선택)", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validators = new Map(CONTRACTS.map((c) => [c.name, ajv.compile(toJsonSchema(c))] as const));
    const { raw } = loadFixture("01-allow");
    expect(validators.get("TestResult")!({ ...raw, source_revision: FULL })).toBe(true);
    expect(validators.get("TestResult")!({ ...raw, source_revision: SOURCE_REVISION_UNKNOWN })).toBe(true);
    expect(validators.get("TestResult")!({ ...raw, source_revision: "ABC" })).toBe(false);
    for (const name of ["TestResult", "Plan", "RollbackRequest", "RollbackPlan"]) {
      const schema = toJsonSchema(CONTRACTS.find((c) => c.name === name)!) as { properties: Record<string, unknown>; required: string[] };
      expect(schema.properties.source_revision, name).toBeDefined();
      expect(schema.required, name).not.toContain("source_revision");
    }
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, policy);
    expect(validators.get("Plan")!(plan)).toBe(true);
    expect(validators.get("Plan")!({ ...plan, source_revision: SOURCE_REVISION_UNKNOWN })).toBe(false); // 출력에는 "unknown" 이 올 수 없다
    expect(PlanSchema.safeParse({ ...plan, source_revision: SOURCE_REVISION_UNKNOWN }).success).toBe(false);
  });
});

describe("decide: plan 과 plan_hash 에 전달", () => {
  it("값이 있으면 plan.source_revision 에 그대로, plan_hash 에도 반영", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, policy);
    expect(plan.source_revision).toBe(FULL);
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    // 판단 결과는 source_revision 과 무관하다
    const bare = decide(without(test), pii, policy);
    expect(bare.source_revision).toBeUndefined();
    expect({ ...plan, source_revision: undefined, plan_hash: undefined }).toEqual({ ...bare, plan_hash: undefined });
    expect(plan.plan_hash).not.toBe(bare.plan_hash);
    // 다른 커밋이면 다른 plan_hash
    expect(decide({ ...test, source_revision: OTHER }, pii, policy).plan_hash).not.toBe(plan.plan_hash);
    // 짧은 해시도 그대로
    expect(decide({ ...test, source_revision: "9f8e7d6" }, pii, policy).source_revision).toBe("9f8e7d6");
  });

  it("값이 없으면 필드 자체가 없고, \"unknown\" 은 없는 것과 같은 plan_hash", () => {
    const { raw, pii } = loadFixture("01-allow");
    const plain = decide(TestResultSchema.parse(raw), pii, policy);
    expect("source_revision" in plain).toBe(false);
    expect(Object.keys(plain)).toEqual(["run_id", "app", "digest", "decision", "targets", "failover_allowed", "rules", "plan_hash"]);
    const unknown = decide(TestResultSchema.parse({ ...raw, source_revision: SOURCE_REVISION_UNKNOWN }), pii, policy);
    expect(unknown).toEqual(plain);
    expect(unknown.plan_hash).toBe(plain.plan_hash);
    // fixture 04 ("unknown") 의 plan 에도 없다
    const { test: t4, pii: p4 } = loadFixture("04-pii-unconfident");
    expect("source_revision" in decide(t4, p4, policy)).toBe(false);
  });
});

describe("decideRollback: rollback_plan 과 plan_hash 에 전달", () => {
  const request = (name: string) => RollbackRequestSchema.parse(readJson(`fixtures/rollback/${name}.json`));

  it("요청에 있으면 rollback_plan.source_revision 에 그대로, 없으면 필드가 없다", () => {
    const withRevision = decideRollback(request("03-pii-onprem"), policy);
    expect(withRevision.source_revision).toBe(FULL);
    expect(() => RollbackPlanSchema.parse(withRevision)).not.toThrow();
    const { source_revision: _omit, ...bareRequest } = request("03-pii-onprem");
    const bare = decideRollback(bareRequest, policy);
    expect("source_revision" in bare).toBe(false);
    expect({ ...withRevision, source_revision: undefined, plan_hash: undefined }).toEqual({ ...bare, plan_hash: undefined });
    expect(withRevision.plan_hash).not.toBe(bare.plan_hash);
    expect(decideRollback({ ...request("03-pii-onprem"), source_revision: OTHER }, policy).plan_hash).not.toBe(withRevision.plan_hash);
    expect("source_revision" in decideRollback(request("05-default"), policy)).toBe(false);
  });
});

describe("결정 기록 (decisions.jsonl)", () => {
  it("DecisionLogSchema: deploy / rollback 모두 선택 필드, 형식 검사", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, policy);
    const base = { kind: "deploy" as const, time: "2026-09-30T00:00:00.000Z", run_id: plan.run_id, digest: plan.digest, decision: plan.decision, targets: plan.targets, rule_ids: ["R4"], plan_hash: plan.plan_hash };
    expect(DecisionLogSchema.safeParse(base).success).toBe(true);
    expect(DecisionLogSchema.safeParse({ ...base, source_revision: FULL }).success).toBe(true);
    expect(DecisionLogSchema.safeParse({ ...base, source_revision: SOURCE_REVISION_UNKNOWN }).success).toBe(false);
    const rb = decideRollback(RollbackRequestSchema.parse(readJson("fixtures/rollback/03-pii-onprem.json")), policy);
    const rbBase = { kind: "rollback" as const, time: "2026-09-30T00:00:00.000Z", run_id: rb.run_id, digest: `sha256:${"3".repeat(64)}`, serve_digest: rb.serve_digest, decision: rb.decision, targets: rb.targets, failover_allowed: rb.failover_allowed, rule_ids: ["RB3", "default"], plan_hash: rb.plan_hash };
    expect(DecisionLogSchema.safeParse(rbBase).success).toBe(true);
    expect(DecisionLogSchema.safeParse({ ...rbBase, source_revision: FULL }).success).toBe(true);
    expect(DecisionLogSchema.safeParse({ ...rbBase, source_revision: "XYZ" }).success).toBe(false);
  });

  it("정책 CLI: plan 에 있으면 기록에도 실리고, 없으면 기록에도 없다", () => {
    const out = tmp();
    const log = join(out, "d.jsonl");
    const withRevision = runCli("src/cli.ts", ["--test", join(ROOT, "fixtures/03-pii-confident/test_result.json"), "--pii", join(ROOT, "fixtures/03-pii-confident/pii.json"), "--policy", POLICY, "--out", join(out, "plan.json"), "--log", log]);
    expect(withRevision.code, withRevision.stderr).toBe(0);
    expect(withRevision.stdout).toContain(`source_revision=${FULL}`);
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")));
    expect(plan.source_revision).toBe(FULL);
    expect(lastLog(log)).toMatchObject({ kind: "deploy", source_revision: FULL, plan_hash: plan.plan_hash });

    const bare = runCli("src/cli.ts", ["--test", join(ROOT, "fixtures/04-pii-unconfident/test_result.json"), "--pii", join(ROOT, "fixtures/04-pii-unconfident/pii.json"), "--policy", POLICY, "--out", join(out, "plan4.json"), "--log", log]);
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.stdout).not.toContain("source_revision");
    expect("source_revision" in lastLog(log)).toBe(false);
    expect("source_revision" in JSON.parse(readFileSync(join(out, "plan4.json"), "utf8"))).toBe(false);
  });

  it("롤백 CLI: 요청에 있으면 rollback_plan 과 기록에 실린다", () => {
    const out = tmp();
    const log = join(out, "d.jsonl");
    const r = runCli("src/rollback/cli.ts", ["--request", join(ROOT, "fixtures/rollback/03-pii-onprem.json"), "--policy", POLICY, "--out", join(out, "rb.json"), "--log", log]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`source_revision=${FULL}`);
    const plan = RollbackPlanSchema.parse(JSON.parse(readFileSync(join(out, "rb.json"), "utf8")));
    expect(plan.source_revision).toBe(FULL);
    expect(lastLog(log)).toMatchObject({ kind: "rollback", source_revision: FULL, plan_hash: plan.plan_hash });

    const bare = runCli("src/rollback/cli.ts", ["--request", join(ROOT, "fixtures/rollback/05-default.json"), "--policy", POLICY, "--out", join(out, "rb5.json"), "--log", log]);
    expect(bare.code, bare.stderr).toBe(0);
    expect("source_revision" in lastLog(log)).toBe(false);
  });
});

describe("보안 단계 실행기 --source-revision", () => {
  const testPath = (name: string) => join(ROOT, "fixtures", name, "test_result.json");
  const src = join(ROOT, "samples", "no-pii");
  const stageCli = (args: string[]) => runCli("src/stage.ts", args);

  it("applySourceRevision: 옵션이 우선, 없으면 test_result 값, 둘 다 있는데 다르면 에러, 형식 오류도 에러", () => {
    const { test } = loadFixture("01-allow");
    expect(applySourceRevision(test, undefined).source_revision).toBeUndefined();
    expect(applySourceRevision(test, FULL).source_revision).toBe(FULL);
    expect(applySourceRevision({ ...test, source_revision: FULL }, FULL).source_revision).toBe(FULL);
    expect(applySourceRevision({ ...test, source_revision: FULL }, undefined).source_revision).toBe(FULL);
    expect(() => applySourceRevision({ ...test, source_revision: FULL }, OTHER)).toThrow(`test_result.source_revision=${FULL} 인데 --source-revision 은 ${OTHER} 입니다`);
    expect(() => applySourceRevision(test, "ABC")).toThrow("--source-revision 형식 오류: ABC");
    expect(() => applySourceRevision(test, SOURCE_REVISION_UNKNOWN)).toThrow("--source-revision 형식 오류");
    // 짧은 해시와 전체 해시는 다른 값이다 (접두어 일치로 봐주지 않는다)
    expect(() => applySourceRevision({ ...test, source_revision: FULL.slice(0, 7) }, FULL)).toThrow("어느 쪽이 맞는지");
  });

  it("옵션을 주면 plan.json, 기록, 요약, out-dir 의 test_result.json 에 실린다 (test_result 에 없거나 \"unknown\" 일 때)", async () => {
    for (const fixture of ["01-allow", "04-pii-unconfident"]) {
      const out = tmp();
      const result = await runStage({ src, testPath: testPath(fixture), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl"), sourceRevision: FULL });
      expect(result.plan.source_revision, fixture).toBe(FULL);
      expect(result.summary.source_revision, fixture).toBe(FULL);
      expect(result.test.source_revision, fixture).toBe(FULL);
      expect(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).source_revision).toBe(FULL);
      expect(JSON.parse(readFileSync(join(out, "test_result.json"), "utf8")).source_revision).toBe(FULL);
      expect(lastLog(join(out, "d.jsonl"))).toMatchObject({ kind: "deploy", source_revision: FULL, plan_hash: result.plan.plan_hash });
      // 남은 test_result.json 으로 정책 CLI 를 돌리면 같은 plan_hash
      const again = runCli("src/cli.ts", ["--test", join(out, "test_result.json"), "--pii", join(out, "pii.json"), "--policy", POLICY, "--out", join(out, "plan2.json"), "--log", join(out, "d2.jsonl")]);
      expect(again.code, again.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(out, "plan2.json"), "utf8")).plan_hash).toBe(result.plan.plan_hash);
    }
  });

  it("옵션이 없으면 test_result 의 값을 쓰고, 그것도 없으면 어디에도 없다", async () => {
    const withValue = tmp();
    const a = await runStage({ src, testPath: testPath("03-pii-confident"), policyPath: POLICY, outDir: withValue, logPath: join(withValue, "d.jsonl") });
    expect(a.plan.source_revision).toBe(FULL);
    expect(lastLog(join(withValue, "d.jsonl")).source_revision).toBe(FULL);

    const none = tmp();
    const b = await runStage({ src, testPath: testPath("01-allow"), policyPath: POLICY, outDir: none, logPath: join(none, "d.jsonl") });
    expect("source_revision" in b.plan).toBe(false);
    expect("source_revision" in b.summary).toBe(false);
    expect("source_revision" in lastLog(join(none, "d.jsonl"))).toBe(false);
    expect("source_revision" in JSON.parse(readFileSync(join(none, "test_result.json"), "utf8"))).toBe(false);
  });

  it("CLI: 같은 값이면 통과, 다르면 종료 코드 1 (test_result 단계), 형식 오류도 1", () => {
    const out = tmp();
    const same = stageCli(["--src", src, "--test", testPath("03-pii-confident"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "d.jsonl"), "--source-revision", FULL]);
    expect(same.code, same.stderr).toBe(0);
    expect(same.stdout).toContain(`source_revision=${FULL}`);

    const conflict = stageCli(["--src", src, "--test", testPath("03-pii-confident"), "--policy", POLICY, "--out-dir", join(out, "conflict"), "--log", join(out, "d.jsonl"), "--source-revision", OTHER]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("[단계: test_result]");
    expect(conflict.stderr).toContain(`test_result.source_revision=${FULL} 인데 --source-revision 은 ${OTHER} 입니다`);

    const badFormat = stageCli(["--src", src, "--test", testPath("01-allow"), "--policy", POLICY, "--out-dir", join(out, "bad"), "--log", join(out, "d.jsonl"), "--source-revision", "ABCDEF0"]);
    expect(badFormat.code).toBe(1);
    expect(badFormat.stderr).toContain("--source-revision 형식 오류: ABCDEF0");

    const json = stageCli(["--src", src, "--test", testPath("01-allow"), "--policy", POLICY, "--out-dir", join(out, "json"), "--log", join(out, "d.jsonl"), "--source-revision", "9f8e7d6", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout.trim())).toMatchObject({ run_id: "r-001", source_revision: "9f8e7d6" });
    expect(stageCli(["--help"]).stdout).toContain("--source-revision");
  });
});

describe("결정 설명: 맨 아래 줄에 커밋 앞 7자리", () => {
  it("shortRevision 은 앞 7자", () => {
    expect(shortRevision(FULL)).toBe("9f8e7d6");
    expect(shortRevision("abcdef0")).toBe("abcdef0");
  });

  it("plan 에 있으면 마지막 줄, 없으면 그 줄이 없다 (ko, ja)", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, policy);
    const ko = explainPlan(plan);
    const ja = explainPlan(plan, { lang: "ja" });
    expect(ko.trimEnd().split("\n").at(-1)).toBe("커밋 `9f8e7d6`");
    expect(ja.trimEnd().split("\n").at(-1)).toBe("コミット`9f8e7d6`");
    expect(ko).not.toContain(FULL);
    expect(ja).not.toContain(FULL);
    expect(ko.endsWith("\n")).toBe(true);

    const bare = explainPlan(decide(without(test), pii, policy));
    expect(bare).not.toContain("커밋");
    expect(bare.trimEnd().split("\n").at(-1)).toMatch(/^결정 지문 `/);
    expect(explainPlan(decide(without(test), pii, policy), { lang: "ja" })).not.toContain("コミット");
  });

  it("롤백 결정서도 같다", () => {
    const rb = decideRollback(RollbackRequestSchema.parse(readJson("fixtures/rollback/03-pii-onprem.json")), policy);
    expect(explainRollbackPlan(rb).trimEnd().split("\n").at(-1)).toBe("커밋 `9f8e7d6`");
    expect(explainRollbackPlan(rb, { lang: "ja" }).trimEnd().split("\n").at(-1)).toBe("コミット`9f8e7d6`");
    const none = decideRollback(RollbackRequestSchema.parse(readJson("fixtures/rollback/05-default.json")), policy);
    expect(explainRollbackPlan(none)).not.toContain("커밋");
  });

  it("실행기 --explain 으로 쓴 설명 파일에도 실린다", async () => {
    const out = tmp();
    const result = await runStage({ src: join(ROOT, "samples", "no-pii"), testPath: join(ROOT, "fixtures", "01-allow", "test_result.json"), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl"), explain: true, sourceRevision: FULL });
    expect(readFileSync(join(out, "explain.ko.md"), "utf8").trimEnd().split("\n").at(-1)).toBe("커밋 `9f8e7d6`");
    expect(readFileSync(join(out, "explain.ja.md"), "utf8")).toBe(explainPlan(result.plan, { lang: "ja" }));
  });

  it("explain CLI 도 같은 출력", () => {
    const dir = tmp();
    const { test, pii } = loadFixture("03-pii-confident");
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(decide(test, pii, policy)));
    const r = runCli("src/explain.ts", ["--plan", planPath]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe("커밋 `9f8e7d6`");
  });
});
