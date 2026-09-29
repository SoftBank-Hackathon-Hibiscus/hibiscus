import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { collectPolicyPaths, lintPolicy } from "../src/policy-refs.js";
import { KNOWN_FACTS_KEYS, PiiReportSchema, PolicySchema, TestResultSchema } from "../src/schema.js";

const ROOT = join(import.meta.dirname, "..");
const policy = PolicySchema.parse(parseYaml(readFileSync(join(ROOT, "policy.yaml"), "utf8")));
const base = JSON.parse(readFileSync(join(ROOT, "fixtures", "01-allow", "test_result.json"), "utf8")) as Record<string, unknown>;
const withFacts = (facts: unknown) => ({ ...base, facts });

describe("test_result.facts: 정책이 읽는 키만 타입 고정", () => {
  it("정의된 키는 db, writes_local_file", () => {
    expect([...KNOWN_FACTS_KEYS].sort()).toEqual(["db", "writes_local_file"]);
  });

  it('facts.db = "SQLite" (대문자) → 형식 오류', () => {
    const result = TestResultSchema.safeParse(withFacts({ db: "SQLite" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["facts", "db"]);
      expect(result.error.issues[0]!.message).toContain("sqlite");
    }
  });

  it("facts.db 에 숫자, writes_local_file 에 문자열 → 형식 오류", () => {
    expect(TestResultSchema.safeParse(withFacts({ db: 3 })).success).toBe(false);
    expect(TestResultSchema.safeParse(withFacts({ writes_local_file: "/app/data.db" })).success).toBe(false);
    expect(TestResultSchema.safeParse(withFacts({ writes_local_file: [1] })).success).toBe(false);
  });

  it("허용된 값은 통과한다", () => {
    for (const db of ["sqlite", "postgres", "mysql", "none"]) {
      expect(TestResultSchema.safeParse(withFacts({ db })).success, db).toBe(true);
    }
    expect(TestResultSchema.safeParse(withFacts({ writes_local_file: [] })).success).toBe(true);
    expect(TestResultSchema.safeParse(withFacts({})).success).toBe(true);
    expect(TestResultSchema.parse({ ...base, facts: undefined }).facts).toEqual({});
  });

  it("정의 안 된 키(framework)는 그대로 통과하고 보존된다", () => {
    const parsed = TestResultSchema.parse(withFacts({ db: "postgres", framework: "express", node: 24 }));
    expect(parsed.facts).toEqual({ db: "postgres", framework: "express", node: 24 });
    // 정책 결정에도 영향이 없다
    const pii = PiiReportSchema.parse({ run_id: parsed.run_id, pii: [] });
    expect(decide(parsed, pii, policy).targets).toEqual(["local", "cloud_run"]);
  });

  it("보존된 추가 키는 plan_hash 에 반영된다 (입력이 다르면 해시도 다르다)", () => {
    const pii = PiiReportSchema.parse({ run_id: base.run_id, pii: [] });
    const a = decide(TestResultSchema.parse(withFacts({ db: "postgres" })), pii, policy);
    const b = decide(TestResultSchema.parse(withFacts({ db: "postgres", framework: "express" })), pii, policy);
    expect(a.plan_hash).not.toBe(b.plan_hash);
  });
});

describe("정책이 읽는 경로 수집", () => {
  it("배포 규칙과 롤백 규칙의 경로를 규칙 id 와 함께 모은다", () => {
    const refs = collectPolicyPaths(policy);
    const deploy = Object.fromEntries(refs.deploy.map((r) => [r.path, r]));
    expect(deploy["test.passed"]?.rules).toEqual(["R1"]);
    expect(deploy["test.run_id"]?.rules).toEqual(["R2"]);
    expect(deploy["pii.run_id"]?.rules).toEqual(["R2"]);
    expect(deploy["pii.pii"]?.rules).toEqual(["R3", "R4"]);
    expect(deploy["pii.pii[].confident"]?.rules).toEqual(["R3"]);
    expect(deploy["pii.pii[].evidence"]?.uses).toEqual(["reason"]);
    expect(deploy["test.facts.db"]?.uses).toEqual(["condition", "reason"]);
    expect(deploy["test.match.matched"]?.uses).toEqual(["reason"]);

    const rollback = Object.fromEntries(refs.rollback.map((r) => [r.path, r]));
    expect(rollback["request.stage"]?.rules).toEqual(["RB1"]);
    expect(rollback["request.state.pii_written_onprem"]?.rules).toEqual(["RB3"]);
    expect(rollback["request.stable.digest"]?.rules).toEqual(["RB1", "RB3", "RB4", "default"]);
  });

  it("경로는 정렬돼 있고 결정적이다", () => {
    const a = collectPolicyPaths(policy).deploy.map((r) => r.path);
    expect(a).toEqual([...a].sort());
    expect(collectPolicyPaths(structuredClone(policy))).toEqual(collectPolicyPaths(policy));
  });
});

describe("정책 경고: 모르는 facts 키", () => {
  const withRule = (rule: unknown) => PolicySchema.parse({ ...policy, rules: [...policy.rules, rule] });

  it("기본 policy.yaml 은 경고가 없다", () => {
    expect(lintPolicy(policy)).toEqual([]);
  });

  it("규칙이 정의되지 않은 facts 키를 읽으면 경고 (규칙 id 와 키 이름 포함)", () => {
    const custom = withRule({
      id: "X9",
      if: { path: "test.facts.framework", eq: "express" },
      then: { targets: ["local"] },
      reason: "express 는 온프레",
    });
    const warnings = lintPolicy(custom);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("X9");
    expect(warnings[0]).toContain("framework");
    expect(warnings[0]).toContain("FactsSchema");
  });

  it("some 안이나 eq_path 로 읽어도 잡는다. 정의된 키는 경고하지 않는다", () => {
    const custom = withRule({
      id: "X10",
      if: { all: [{ some: "test.facts.ports" }, { path: "test.facts.db", ne_path: "test.facts.engine" }] },
      then: { failover_allowed: false },
      reason: "x",
    });
    const warnings = lintPolicy(custom);
    expect(warnings.map((w) => /facts 키를 읽습니다: (\w+)/.exec(w)?.[1])).toEqual(["engine", "ports"]);
  });

  it("경고는 로드를 막지 않는다 (결정은 그대로 된다)", () => {
    const custom = withRule({ id: "X9", if: { path: "test.facts.framework", eq: "express" }, then: { targets: ["local"] }, reason: "x" });
    const test = TestResultSchema.parse(withFacts({ db: "postgres", framework: "express" }));
    const plan = decide(test, PiiReportSchema.parse({ run_id: test.run_id, pii: [] }), custom);
    expect(plan.targets).toEqual(["local"]);
  });
});
