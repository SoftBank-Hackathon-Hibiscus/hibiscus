import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { PiiReportSchema, PlanSchema, PolicySchema, TestResultSchema, type PiiReport, type TestResult } from "../src/schema.js";

const ROOT = join(import.meta.dirname, "..");

function loadFixture(name: string): { test: TestResult; pii: PiiReport } {
  const dir = join(ROOT, "fixtures", name);
  return {
    test: TestResultSchema.parse(JSON.parse(readFileSync(join(dir, "test_result.json"), "utf8"))),
    pii: PiiReportSchema.parse(JSON.parse(readFileSync(join(dir, "pii.json"), "utf8"))),
  };
}

const policy = PolicySchema.parse(parseYaml(readFileSync(join(ROOT, "policy.yaml"), "utf8")));

const matchedIds = (plan: ReturnType<typeof decide>) =>
  plan.rules.filter((r) => r.result === "matched").map((r) => r.id);

describe("fixtures", () => {
  it("(1) 정상 → allow, local + cloud_run, failover 허용", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, policy);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local", "cloud_run"]);
    expect(plan.failover_allowed).toBe(true);
    expect(matchedIds(plan)).toEqual(["default"]);
    // digest / run_id 는 입력 그대로 전달
    expect(plan.run_id).toBe(test.run_id);
    expect(plan.digest).toBe(test.digest);
    expect(plan.app).toBe(test.app);
    expect(() => PlanSchema.parse(plan)).not.toThrow();
  });

  it("(2) 테스트 실패 → block, targets 없음, 이후 규칙은 평가하지 않음", () => {
    const { test, pii } = loadFixture("02-block-test-failed");
    const plan = decide(test, pii, policy);

    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(plan.failover_allowed).toBe(false);
    expect(plan.rules).toEqual([{ id: "R1", result: "matched", reason: "테스트 실패 (17/20 일치)" }]);
  });

  it("(3) 개인정보 확신 있음 → allow, local 만, failover 금지", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, policy);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["R4"]);
    expect(plan.rules.find((r) => r.id === "R4")?.reason).toBe("개인정보(contact, phone) 발견: src/routes/signup.js:24");
    expect(plan.rules.find((r) => r.id === "R3")).toEqual({ id: "R3", result: "not_matched" });
  });

  it("(4) 개인정보 확신 없음 → needs_approval, local 만, failover 금지", () => {
    const { test, pii } = loadFixture("04-pii-unconfident");
    const plan = decide(test, pii, policy);

    expect(plan.decision).toBe("needs_approval");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["R3", "R4"]);
    // R3 의 reason 은 확신 없는 후보만 담는다
    expect(plan.rules.find((r) => r.id === "R3")?.reason).toBe(
      "확신 없는 개인정보 후보(todos.note, free_text_maybe_address): src/routes/todos.js:41",
    );
    // R4 의 reason 은 모든 후보를 "; " 로 잇는다
    expect(plan.rules.find((r) => r.id === "R4")?.reason).toBe(
      "개인정보(contact, phone) 발견: src/routes/signup.js:24; 개인정보(note, free_text_maybe_address) 발견: src/routes/todos.js:41",
    );
  });
});

describe("R2: run_id 불일치", () => {
  it("test_result 와 pii 의 run_id 가 다르면 block", () => {
    const { test } = loadFixture("01-allow");
    const pii: PiiReport = { run_id: "r-999", pii: [] };
    const plan = decide(test, pii, policy);

    expect(plan.decision).toBe("block");
    expect(matchedIds(plan)).toEqual(["R2"]);
    expect(plan.rules.find((r) => r.id === "R2")?.reason).toBe("입력 불일치: test_result.run_id=r-001 != pii.run_id=r-999");
  });
});

describe("결정성 (plan_hash)", () => {
  it("같은 입력이면 같은 plan_hash", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const a = decide(test, pii, policy);
    const b = decide(structuredClone(test), structuredClone(pii), structuredClone(policy));
    expect(a.plan_hash).toBe(b.plan_hash);
    expect(a).toEqual(b);
  });

  it("키 순서가 달라도 같은 plan_hash", () => {
    const { test, pii } = loadFixture("01-allow");
    const reordered = { facts: test.facts, failures: test.failures, match: test.match, passed: test.passed, digest: test.digest, app: test.app, run_id: test.run_id };
    expect(decide(reordered, pii, policy).plan_hash).toBe(decide(test, pii, policy).plan_hash);
  });

  it("입력이 하나라도 다르면 plan_hash 가 달라진다", () => {
    const { test, pii } = loadFixture("01-allow");
    const base = decide(test, pii, policy).plan_hash;
    expect(decide({ ...test, digest: "sha256:ffff" }, pii, policy).plan_hash).not.toBe(base);
    expect(decide(test, { ...pii, pii: [{ table: "u", column: "c", kind: "k", evidence: "e", confident: true }] }, policy).plan_hash).not.toBe(base);
    const otherPolicy = { ...policy, default: { ...policy.default, failover_allowed: false } };
    expect(decide(test, pii, otherPolicy).plan_hash).not.toBe(base);
  });

  it("plan_hash 는 64자리 hex", () => {
    const { test, pii } = loadFixture("01-allow");
    expect(decide(test, pii, policy).plan_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("policy 스키마", () => {
  it("규칙 id 가 중복되면 거부", () => {
    const dup = { ...policy, rules: [policy.rules[0], policy.rules[0]] };
    expect(PolicySchema.safeParse(dup).success).toBe(false);
  });

  it("알 수 없는 조건 키는 거부", () => {
    const bad = { ...policy, rules: [{ id: "X", if: { path: "test.passed", equals: false }, then: {}, reason: "x" }] };
    expect(PolicySchema.safeParse(bad).success).toBe(false);
  });

  it("규칙 내용을 바꿔도 엔진 코드는 그대로: 'sqlite 면 local 만' 규칙 추가", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        ...policy.rules,
        {
          id: "C1",
          if: { all: [{ path: "test.facts.db", eq: "sqlite" }, { some: "test.facts.writes_local_file" }] },
          then: { targets: ["local"], failover_allowed: false },
          reason: "로컬 파일 DB({test.facts.db}) 사용",
        },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(matchedIds(plan)).toEqual(["C1"]);
    expect(plan.rules.find((r) => r.id === "C1")?.reason).toBe("로컬 파일 DB(sqlite) 사용");
  });
});
