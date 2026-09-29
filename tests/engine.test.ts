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

  it("(2) 테스트 실패 → block, targets 없음. 뒤 규칙도 끝까지 평가되고 걸린 것은 matched_after_block", () => {
    const { test, pii } = loadFixture("02-block-test-failed");
    const plan = decide(test, pii, policy);

    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(plan.failover_allowed).toBe(false);
    // fixture 02 는 facts.db = sqlite 라 R5 가 차단 뒤에 걸린다 (data.db 는 R6 가 무시)
    expect(plan.rules).toEqual([
      { id: "R1", result: "matched", reason: "테스트 실패 (17/20 일치)" },
      { id: "R2", result: "not_matched" },
      { id: "R3", result: "not_matched" },
      { id: "R4", result: "not_matched" },
      { id: "R5", result: "matched_after_block", reason: "SQLite 사용 (sqlite): 관리형 DB로 전환하기 전까지 클라우드 배포 제외" },
      { id: "R6", result: "not_matched" },
    ]);
    expect(plan.requires?.map((r) => r.id)).toEqual(["fix_tests", "managed_db"]);
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

describe("targets 좁히기 / failover 는 false 가 이긴다", () => {
  const withRules = (...extra: unknown[]) => PolicySchema.parse({ ...policy, rules: [...policy.rules, ...extra] });

  it("R4 뒤에 '테스트 통과 → [local, cloud_run]' 규칙을 추가해도 개인정보 앱은 [local] 만", () => {
    const custom = withRules({
      id: "X1",
      if: { path: "test.passed", eq: true },
      then: { targets: ["local", "cloud_run"], failover_allowed: true },
      reason: "테스트 통과",
    });
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, custom);

    expect(plan.decision).toBe("allow");
    expect(matchedIds(plan)).toEqual(["R4", "X1"]);
    expect(plan.targets).toEqual(["local"]);
    // R4 가 false 로 정한 failover 를 X1 이 true 로 되돌리지 못한다
    expect(plan.failover_allowed).toBe(false);

    // 개인정보가 없는 앱은 X1 이 첫 targets 이므로 그대로 [local, cloud_run]
    const clean = loadFixture("01-allow");
    const cleanPlan = decide(clean.test, clean.pii, custom);
    expect(cleanPlan.targets).toEqual(["local", "cloud_run"]);
    expect(cleanPlan.failover_allowed).toBe(true);
    expect(matchedIds(cleanPlan)).toEqual(["X1"]);
  });

  it("targets 만 [local] 로 정하고 failover 를 안 적은 규칙 → failover_allowed=false", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [{ id: "L1", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, reason: "온프레만" }],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    // default.failover_allowed 는 true 지만 cloud_run 이 없으므로 failover 불가
    expect(plan.failover_allowed).toBe(false);
  });

  it("두 규칙의 targets 교집합이 비면 block", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "A", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, reason: "A" },
        { id: "B", if: { path: "test.passed", eq: true }, then: { targets: ["cloud_run"] }, reason: "B" },
        { id: "C", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, reason: "C" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);

    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(plan.failover_allowed).toBe(false);
    // B 에서 block 이 정해지지만 C 도 평가된다 (matched_after_block). 이미 빈 targets 는 다시 좁히지 않는다
    expect(matchedIds(plan)).toEqual(["A", "B"]);
    expect(plan.rules.find((r) => r.id === "C")).toEqual({ id: "C", result: "matched_after_block", reason: "C" });
    expect(plan.requires?.map((r) => r.id)).toEqual(["resolve_target_conflict"]);
    expect(plan.rules.find((r) => r.id === "B")?.reason).toContain("허용된 배포 대상이 없음");
  });

  it("교집합은 default 목록의 순서를 유지한다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      known_targets: ["local", "cloud_run", "edge"],
      default: { ...policy.default, targets: ["cloud_run", "local", "edge"] },
      rules: [
        { id: "A", if: { path: "test.passed", eq: true }, then: { targets: ["local", "edge", "cloud_run"] }, reason: "A" },
        { id: "B", if: { path: "test.passed", eq: true }, then: { targets: ["local", "cloud_run"] }, reason: "B" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.targets).toEqual(["cloud_run", "local"]);
    expect(plan.failover_allowed).toBe(true);
  });
});

describe("배포 대상 검증 (known_targets) / 좁히기 시작점은 default", () => {
  it("known_targets 에 없는 대상(오타 cloudrun)을 규칙에 적으면 정책 로드 단계에서 에러", () => {
    const result = PolicySchema.safeParse({
      ...policy,
      rules: [
        ...policy.rules,
        { id: "R9", if: { path: "test.passed", eq: true }, then: { targets: ["local", "cloudrun"] }, reason: "오타" },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.message.includes("cloudrun"));
    expect(issue?.message).toBe("알 수 없는 배포 대상: cloudrun (규칙 R9)");
    expect(issue?.path).toEqual(["rules", policy.rules.length, "then", "targets", 1]);
  });

  it("default.targets 에 known_targets 에 없는 대상이 있어도 에러", () => {
    const result = PolicySchema.safeParse({ ...policy, default: { ...policy.default, targets: ["local", "onprem"] } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.message)).toContain("알 수 없는 배포 대상: onprem (default)");
  });

  it("규칙이 [local, aws] 를 적어도 default 에 aws 가 없으면 결과는 [local]", () => {
    const custom = PolicySchema.parse({
      ...policy,
      known_targets: ["local", "cloud_run", "aws"],
      rules: [{ id: "A1", if: { path: "test.passed", eq: true }, then: { targets: ["local", "aws"] }, reason: "aws 도" }],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["A1"]);
  });

  it("default 가 [local, cloud_run] 이고 규칙이 [cloud_run] 만 적으면 [cloud_run], failover=false", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [{ id: "C1", if: { path: "test.passed", eq: true }, then: { targets: ["cloud_run"] }, reason: "클라우드만" }],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["cloud_run"]);
    expect(plan.failover_allowed).toBe(false);
    // 규칙이 targets 를 정했으므로 default 는 기록되지 않는다
    expect(matchedIds(plan)).toEqual(["C1"]);
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
    const sqliteTest = { ...test, facts: { db: "sqlite" as const, writes_local_file: ["/app/data.db"] } };
    const plan = decide(sqliteTest, pii, custom);
    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    // /app/data.db 는 DB 파일이라 R6 가 무시하므로 R5 와 C1 만 걸린다
    expect(matchedIds(plan)).toEqual(["R5", "C1"]);
    expect(plan.rules.find((r) => r.id === "C1")?.reason).toBe("로컬 파일 DB(sqlite) 사용");
  });
});

describe("해결 조건 (requires)", () => {
  it("R1 테스트 실패 → block 에 fix_tests 해결 조건", () => {
    const { test, pii } = loadFixture("02-block-test-failed");
    // 다른 규칙이 섞이지 않게 facts 를 비운다 (fixture 그대로면 R5 도 걸린다)
    const plan = decide({ ...test, facts: { db: "postgres" as const } }, pii, policy);
    expect(plan.decision).toBe("block");
    expect(plan.requires).toEqual([{ id: "fix_tests", hint: "재생 불일치 요청을 고친 뒤 다시 테스트", rule_id: "R1", allowed_targets: ["local", "cloud_run"] }]);
  });

  it("R2 입력 불일치 → rerun_same_run", () => {
    const { test } = loadFixture("01-allow");
    const plan = decide(test, { run_id: "r-999", pii: [] }, policy);
    expect(plan.decision).toBe("block");
    expect(plan.requires).toEqual([{ id: "rerun_same_run", hint: "같은 run_id로 테스트와 개인정보 판정을 다시 실행", rule_id: "R2", allowed_targets: ["local", "cloud_run"] }]);
  });

  it("R3 개인정보 애매 → needs_approval 에 human_review_pii. R4 는 해결 조건이 없다", () => {
    const { test, pii } = loadFixture("04-pii-unconfident");
    const plan = decide(test, pii, policy);
    expect(plan.decision).toBe("needs_approval");
    expect(matchedIds(plan)).toEqual(["R3", "R4"]);
    expect(plan.requires).toEqual([{ id: "human_review_pii", hint: "해당 칼럼이 개인정보인지 사람이 확인", rule_id: "R3", allowed_targets: ["local"] }]);
  });

  it("문자열만 적은 requires 는 id 만 있는 것으로 본다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [{ id: "S1", if: { path: "test.passed", eq: true }, then: { targets: ["local"], requires: ["managed_db", { id: "cdn", hint: "CDN 앞단" }] }, reason: "s" }],
    });
    expect(custom.rules[0]!.then.requires).toEqual([{ id: "managed_db" }, { id: "cdn", hint: "CDN 앞단" }]);
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.requires).toEqual([
      { id: "cdn", hint: "CDN 앞단", rule_id: "S1", allowed_targets: ["local"] },
      { id: "managed_db", rule_id: "S1", allowed_targets: ["local"] },
    ]);
  });

  it("같은 id 를 여러 규칙이 요구하면 하나로 합치고 먼저 요구한 규칙의 hint 와 rule_id 가 남는다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "A", if: { path: "test.passed", eq: true }, then: { requires: [{ id: "managed_db", hint: "A 의 설명" }] }, reason: "a" },
        { id: "B", if: { path: "test.passed", eq: true }, then: { requires: [{ id: "managed_db", hint: "B 의 설명" }, "zzz"] }, reason: "b" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.requires).toEqual([
      { id: "managed_db", hint: "A 의 설명", rule_id: "A", allowed_targets: ["local", "cloud_run"] },
      { id: "zzz", rule_id: "B", allowed_targets: ["local", "cloud_run"] },
    ]);
  });

  it("block / needs_approval 을 내는 규칙에 requires 가 없으면 정책 로드 에러", () => {
    for (const decision of ["block", "needs_approval"]) {
      const result = PolicySchema.safeParse({
        ...policy,
        rules: [{ id: "N1", if: { path: "test.passed", eq: false }, then: { decision }, reason: "x" }],
      });
      expect(result.success, decision).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.message.includes("requires"));
        expect(issue?.message).toBe(`규칙 N1: decision '${decision}' 을(를) 내는 규칙은 requires(해결 조건)가 최소 1개 있어야 합니다`);
        expect(issue?.path).toEqual(["rules", 0, "then", "requires"]);
      }
    }
    // 빈 배열도 안 된다
    expect(PolicySchema.safeParse({ ...policy, rules: [{ id: "N2", if: { path: "test.passed", eq: false }, then: { decision: "block", requires: [] }, reason: "x" }] }).success).toBe(false);
    // targets 만 정하는 규칙은 requires 가 없어도 된다
    expect(PolicySchema.safeParse({ ...policy, rules: [{ id: "N3", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, reason: "x" }] }).success).toBe(true);
  });

  it("교집합이 비어 엔진이 block 하면 resolve_target_conflict 해결 조건을 넣는다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "A", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, reason: "A" },
        { id: "B", if: { path: "test.passed", eq: true }, then: { targets: ["cloud_run"] }, reason: "B" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.decision).toBe("block");
    expect(plan.requires?.map((r) => [r.id, r.rule_id])).toEqual([["resolve_target_conflict", "B"]]);
    // 교집합이 비기 직전의 targets 가 allowed_targets
    expect(plan.requires?.[0]?.allowed_targets).toEqual(["local"]);
  });

  it("block / needs_approval 인 plan 에는 항상 해결 조건이 있다 (fixtures 전부)", () => {
    for (const f of ["01-allow", "02-block-test-failed", "03-pii-confident", "04-pii-unconfident"]) {
      const { test, pii } = loadFixture(f);
      const plan = decide(test, pii, policy);
      if (plan.decision !== "allow") expect(plan.requires?.length, f).toBeGreaterThan(0);
    }
  });
});

describe("block 이후 계속 평가 / halt", () => {
  it("테스트 실패 + 개인정보 + SQLite → block, requires 는 fix_tests + managed_db, allowed_targets [local], R4·R5 는 matched_after_block", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const failed = { ...test, passed: false, match: { total: 24, matched: 20 }, facts: { db: "sqlite" as const } };
    const plan = decide(failed, pii, policy);

    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(plan.failover_allowed).toBe(false);
    expect(plan.rules.map((r) => [r.id, r.result])).toEqual([
      ["R1", "matched"],
      ["R2", "not_matched"],
      ["R3", "not_matched"],
      ["R4", "matched_after_block"],
      ["R5", "matched_after_block"],
      ["R6", "not_matched"],
    ]);
    expect(plan.rules.find((r) => r.id === "R4")?.reason).toBe("개인정보(contact, phone) 발견: src/routes/signup.js:24");
    expect(plan.requires).toEqual([
      { id: "fix_tests", hint: "재생 불일치 요청을 고친 뒤 다시 테스트", rule_id: "R1", allowed_targets: ["local"] },
      { id: "managed_db", hint: "SQLite를 PostgreSQL로 전환 (allowed_targets 안의 환경에서)", rule_id: "R5", allowed_targets: ["local"] },
    ]);
  });

  it("run_id 불일치 + 개인정보 → R2(halt) 에서 즉시 멈추고 R4 는 기록되지 않는다", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, { ...pii, run_id: "r-999" }, policy);

    expect(plan.decision).toBe("block");
    expect(plan.rules.map((r) => r.id)).toEqual(["R1", "R2"]);
    expect(plan.rules.find((r) => r.id === "R4")).toBeUndefined();
    expect(plan.requires).toEqual([{ id: "rerun_same_run", hint: "같은 run_id로 테스트와 개인정보 판정을 다시 실행", rule_id: "R2", allowed_targets: ["local", "cloud_run"] }]);
  });

  it("block 뒤의 규칙은 decision 을 바꾸지 못한다 (needs_approval 이 와도 block 유지)", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "B1", if: { path: "test.passed", eq: true }, then: { decision: "block", requires: ["fix_b"] }, reason: "b" },
        { id: "A1", if: { path: "test.passed", eq: true }, then: { decision: "needs_approval", targets: ["local"], requires: ["review_a"] }, reason: "a" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.decision).toBe("block");
    expect(plan.rules.map((r) => [r.id, r.result])).toEqual([
      ["B1", "matched"],
      ["A1", "matched_after_block"],
    ]);
    // A1 의 좁히기와 해결 조건은 반영된다
    expect(plan.requires?.map((r) => [r.id, r.rule_id, r.allowed_targets])).toEqual([
      ["fix_b", "B1", ["local"]],
      ["review_a", "A1", ["local"]],
    ]);
  });

  it("halt: true 인 규칙이 걸리면 decision 과 무관하게 즉시 멈춘다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "H1", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, halt: true, reason: "h" },
        { id: "N1", if: { path: "test.passed", eq: true }, then: { targets: ["cloud_run"] }, reason: "n" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.rules.map((r) => r.id)).toEqual(["H1"]);
    // halt 인 규칙이 안 걸리면 멈추지 않는다 (둘 다 안 걸리므로 default 가 기록된다)
    const notMatched = decide({ ...test, passed: false, match: { total: 1, matched: 0 } }, pii, custom);
    expect(notMatched.rules.map((r) => r.id)).toEqual(["H1", "N1", "default"]);
  });

  it("교집합 공백으로 block 된 뒤에는 targets 를 다시 좁히지 않아 충돌 사유가 중복되지 않는다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "A", if: { path: "test.passed", eq: true }, then: { targets: ["local"] }, reason: "A" },
        { id: "B", if: { path: "test.passed", eq: true }, then: { targets: ["cloud_run"] }, reason: "B" },
        { id: "C", if: { path: "test.passed", eq: true }, then: { targets: ["cloud_run"], requires: ["c_fix"] }, reason: "C" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.rules.find((r) => r.id === "B")?.reason).toContain("허용된 배포 대상이 없음");
    expect(plan.rules.find((r) => r.id === "C")?.reason).toBe("C");
    expect(plan.requires?.map((r) => [r.id, r.allowed_targets])).toEqual([
      ["c_fix", ["local"]],
      ["resolve_target_conflict", ["local"]],
    ]);
  });
});

describe("해결 조건의 allowed_targets", () => {
  const allowedOf = (plan: ReturnType<typeof decide>, id: string) => plan.requires?.find((r) => r.id === id)?.allowed_targets;

  it("개인정보 + SQLite → managed_db 의 allowed_targets = [local]", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide({ ...test, facts: { db: "sqlite" as const } }, pii, policy);
    expect(plan.targets).toEqual(["local"]);
    expect(allowedOf(plan, "managed_db")).toEqual(["local"]);
  });

  it("SQLite 만 → allowed_targets = [local] (R5 가 cloud_run 을 뺐으므로)", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { db: "sqlite" as const } }, pii, policy);
    expect(allowedOf(plan, "managed_db")).toEqual(["local"]);
  });

  it("테스트 실패로 차단 → fix_tests 의 allowed_targets = 끝까지 좁힌 targets (빈 배열이 아님)", () => {
    const { test, pii } = loadFixture("02-block-test-failed");
    // 좁히는 규칙이 없으면 default 그대로
    const plain = decide({ ...test, facts: { db: "postgres" as const } }, pii, policy);
    expect(plain.targets).toEqual([]);
    expect(allowedOf(plain, "fix_tests")).toEqual(["local", "cloud_run"]);
    // fixture 그대로(sqlite)면 차단 뒤 R5 가 좁혀 [local]
    const narrowed = decide(test, pii, policy);
    expect(allowedOf(narrowed, "fix_tests")).toEqual(["local"]);
  });

  it("좁힌 뒤에 차단되면 좁힌 targets 가 allowed_targets (개인정보 앱이 이후 규칙에 걸려 차단)", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        ...policy.rules,
        { id: "X1", if: { path: "test.app", eq: "todo" }, then: { decision: "block", requires: [{ id: "fix_x", hint: "x" }] }, reason: "x" },
      ],
    });
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide(test, pii, custom);
    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(matchedIds(plan)).toEqual(["R4", "X1"]);
    expect(allowedOf(plan, "fix_x")).toEqual(["local"]);
  });

  it("한 결정서의 모든 해결 조건은 같은 allowed_targets 를 가진다", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { db: "sqlite" as const, writes_local_file: ["/app/uploads/cat.png"] } }, pii, policy);
    expect(plan.requires?.map((r) => r.allowed_targets)).toEqual([["local"], ["local"]]);
    expect(() => PlanSchema.parse(plan)).not.toThrow();
  });
});

describe("R6: 로컬 파일 쓰기", () => {
  const withWrites = (writes: string[]) => {
    const { test, pii } = loadFixture("01-allow");
    return decide({ ...test, facts: { db: "postgres" as const, writes_local_file: writes } }, pii, policy);
  };

  it("업로드 폴더에 쓰면 → targets [local], failover false, object_storage, reason 에 경로", () => {
    const plan = withWrites(["/app/uploads/avatar.png"]);
    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["R6"]);
    expect(plan.rules.find((r) => r.id === "R6")?.reason).toBe("로컬 파일 쓰기: /app/uploads/avatar.png");
    expect(plan.requires).toEqual([{ id: "object_storage", hint: "로컬 폴더에 쓰는 파일을 오브젝트 스토리지로 이전 (allowed_targets 안의 환경에서)", rule_id: "R6", allowed_targets: ["local"] }]);
  });

  it("/tmp 와 로그 파일만 쓰면 걸리지 않는다", () => {
    const plan = withWrites(["/tmp/cache.bin", "/var/log/app.log"]);
    expect(plan.targets).toEqual(["local", "cloud_run"]);
    expect(plan.rules.find((r) => r.id === "R6")).toEqual({ id: "R6", result: "not_matched" });
    expect(plan.requires).toBeUndefined();
  });

  it("무시 경로와 섞여 있으면 무시 경로는 reason 에 나오지 않는다", () => {
    const plan = withWrites(["/tmp/x", "/app/uploads/a.png", "/var/log/app.log", "/app/data/b.csv"]);
    expect(plan.rules.find((r) => r.id === "R6")?.reason).toBe("로컬 파일 쓰기: /app/uploads/a.png; 로컬 파일 쓰기: /app/data/b.csv");
  });

  it("빈 배열이거나 키가 없으면 걸리지 않는다", () => {
    expect(withWrites([]).targets).toEqual(["local", "cloud_run"]);
    const { test, pii } = loadFixture("01-allow");
    expect(decide({ ...test, facts: {} }, pii, policy).targets).toEqual(["local", "cloud_run"]);
  });

  it("db: sqlite + writes [/app/data.db] → R5 만 걸리고 requires 는 managed_db 하나 (DB 파일은 R6 가 무시)", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { db: "sqlite" as const, writes_local_file: ["/app/data.db"] } }, pii, policy);
    expect(matchedIds(plan)).toEqual(["R5"]);
    expect(plan.rules.find((r) => r.id === "R6")).toEqual({ id: "R6", result: "not_matched" });
    expect(plan.requires).toEqual([{ id: "managed_db", hint: "SQLite를 PostgreSQL로 전환 (allowed_targets 안의 환경에서)", rule_id: "R5", allowed_targets: ["local"] }]);
  });

  it("db: sqlite + writes [/app/data.db, /app/uploads/cat.png] → R5 와 R6 모두, R6 reason 에는 cat.png 만", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { db: "sqlite" as const, writes_local_file: ["/app/data.db", "/app/uploads/cat.png"] } }, pii, policy);
    expect(matchedIds(plan)).toEqual(["R5", "R6"]);
    expect(plan.requires?.map((r) => r.id)).toEqual(["managed_db", "object_storage"]);
    expect(plan.rules.find((r) => r.id === "R6")?.reason).toBe("로컬 파일 쓰기: /app/uploads/cat.png");
  });

  it("DB 파일 확장자는 대소문자를 가리지 않고 무시한다 (.db, .sqlite, .sqlite3)", () => {
    const ignored = withWrites(["/app/DATA.DB", "/var/lib/app/main.SQLite", "/data/notes.sqlite3", "/x/y.Sqlite3"]);
    expect(ignored.rules.find((r) => r.id === "R6")).toEqual({ id: "R6", result: "not_matched" });
    expect(ignored.targets).toEqual(["local", "cloud_run"]);
    // .dbx 나 .sqlite 가 중간에 있는 이름은 무시하지 않는다
    const notIgnored = withWrites(["/app/export.dbx", "/app/sqlite.backup"]);
    expect(notIgnored.rules.find((r) => r.id === "R6")?.reason).toBe("로컬 파일 쓰기: /app/export.dbx; 로컬 파일 쓰기: /app/sqlite.backup");
  });

  it("matches 의 flags 는 검증된다", () => {
    const rule = (flags: unknown) => ({ id: "F1", if: { path: "test.app", matches: "todo", flags }, then: {}, reason: "x" });
    expect(PolicySchema.safeParse({ ...policy, rules: [rule("i")] }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...policy, rules: [rule("x")] }).success).toBe(false);
    const { test, pii } = loadFixture("01-allow");
    const custom = PolicySchema.parse({ ...policy, rules: [{ id: "F1", if: { path: "test.app", matches: "^TODO$", flags: "i" }, then: { targets: ["local"] }, reason: "x" }] });
    expect(matchedIds(decide(test, pii, custom))).toEqual(["F1"]);
  });

  it("조건 DSL: starts_with / matches / @", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "M1", if: { some: "test.facts.writes_local_file", where: { path: "@", matches: "^/data/.*\\.db$" } }, then: { targets: ["local"] }, reason: "db 파일: {@}" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { writes_local_file: ["/data/app.db", "/data/notes.txt"] } }, pii, custom);
    expect(plan.rules.find((r) => r.id === "M1")?.reason).toBe("db 파일: /data/app.db");
    expect(PolicySchema.safeParse({ ...policy, rules: [{ id: "M2", if: { path: "test.app", matches: "(" }, then: {}, reason: "x" }] }).success).toBe(false);
  });
});

describe("R5: SQLite / requires", () => {
  it("facts.db = sqlite → targets [local], failover false, requires [managed_db]", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { db: "sqlite" } }, pii, policy);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(plan.requires).toEqual([{ id: "managed_db", hint: "SQLite를 PostgreSQL로 전환 (allowed_targets 안의 환경에서)", rule_id: "R5", allowed_targets: ["local"] }]);
    expect(matchedIds(plan)).toEqual(["R5"]);
    expect(plan.rules.find((r) => r.id === "R5")?.reason).toBe("SQLite 사용 (sqlite): 관리형 DB로 전환하기 전까지 클라우드 배포 제외");
  });

  it("facts.db = postgres → 기존과 동일 (requires 없음)", () => {
    const { test, pii } = loadFixture("01-allow");
    const plan = decide({ ...test, facts: { db: "postgres" } }, pii, policy);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local", "cloud_run"]);
    expect(plan.failover_allowed).toBe(true);
    expect(plan.requires).toBeUndefined();
    expect("requires" in plan).toBe(false);
    expect(matchedIds(plan)).toEqual(["default"]);
  });

  it("sqlite + 개인정보 → targets [local], requires [managed_db], 두 규칙 모두 기록", () => {
    const { test, pii } = loadFixture("03-pii-confident");
    const plan = decide({ ...test, facts: { db: "sqlite" } }, pii, policy);

    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(plan.requires).toEqual([{ id: "managed_db", hint: "SQLite를 PostgreSQL로 전환 (allowed_targets 안의 환경에서)", rule_id: "R5", allowed_targets: ["local"] }]);
    expect(matchedIds(plan)).toEqual(["R4", "R5"]);
  });

  it("requires 는 걸린 규칙들의 것을 합쳐 중복 제거·정렬한다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [
        { id: "A", if: { path: "test.passed", eq: true }, then: { requires: ["managed_db", "secrets_manager"] }, reason: "A" },
        { id: "B", if: { path: "test.passed", eq: true }, then: { requires: ["managed_db", "cdn"] }, reason: "B" },
        { id: "C", if: { path: "test.passed", eq: false }, then: { requires: ["never"] }, reason: "C" },
      ],
    });
    const { test, pii } = loadFixture("01-allow");
    const plan = decide(test, pii, custom);
    expect(plan.requires).toEqual([
      { id: "cdn", rule_id: "B", allowed_targets: ["local", "cloud_run"] },
      { id: "managed_db", rule_id: "A", allowed_targets: ["local", "cloud_run"] },
      { id: "secrets_manager", rule_id: "A", allowed_targets: ["local", "cloud_run"] },
    ]);
    // targets 를 정한 규칙이 없으므로 default 가 쓰인다
    expect(matchedIds(plan)).toEqual(["A", "B", "default"]);
  });

  it("requires 가 plan_hash 에 반영된다", () => {
    const { test, pii } = loadFixture("01-allow");
    const sqlite = decide({ ...test, facts: { db: "sqlite" } }, pii, policy);
    const postgres = decide({ ...test, facts: { db: "postgres" } }, pii, policy);
    expect(sqlite.plan_hash).not.toBe(postgres.plan_hash);
    expect(() => PlanSchema.parse(sqlite)).not.toThrow();
  });
});
