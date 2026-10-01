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
  it("정의된 키는 conditions, db, migration, storage, writes_local_file", () => {
    expect([...KNOWN_FACTS_KEYS].sort()).toEqual(["conditions", "db", "migration", "storage", "writes_local_file"]);
  });

  const passAll = (name: string) => ({ name, total: 20, matched: 20, failed: false, mismatches: [] });
  const uploads = { index: 16, request: "GET /uploads", related_fact: "/app/uploads", related_storage: "container_layer", related_kind: "local_upload" };
  const posts = { index: 13, request: "GET /posts", related_fact: "/app/data/data.db", related_storage: "container_layer", related_kind: "sqlite" };
  const replace16 = { name: "replace", total: 20, matched: 19, failed: true, mismatches: [uploads] };
  /** none, restart 통과 + replace 는 주어진 값 */
  const trio = (replace: unknown = replace16) => [passAll("none"), passAll("restart"), replace];
  /** replace16 의 related_* 를 뒷받침하는 저장 사실 (R6 가 읽는 writes_local_file 포함) */
  const uploadsEvidence = { storage: [{ kind: "local_upload", path: "/app/uploads", storage: "container_layer" }], writes_local_file: ["/app/uploads"] };
  const sqliteEvidence = { storage: [{ kind: "sqlite", path: "/app/data/data.db", storage: "container_layer" }], db: "sqlite" };

  it("facts.conditions / facts.storage: 없는 값은 null 이 아니라 키 생략이어야 한다", () => {
    expect(TestResultSchema.safeParse(withFacts({ ...uploadsEvidence, conditions: trio() })).success).toBe(true);
    expect(TestResultSchema.safeParse(withFacts({ conditions: trio({ ...replace16, mismatches: [{ index: 11, request: "GET /me" }] }) })).success).toBe(true);
    // null 은 거부 (조건 DSL 의 exists 가 null 을 "있음" 으로 보기 때문에 생략만 허용)
    expect(TestResultSchema.safeParse(withFacts({ conditions: trio({ ...replace16, mismatches: [{ index: 11, request: "GET /me", related_fact: null }] }) })).success).toBe(false);
    expect(TestResultSchema.safeParse(withFacts({ conditions: trio({ ...replace16, failed: "yes" }) })).success).toBe(false);
    expect(TestResultSchema.safeParse(withFacts({ storage: [{ kind: "sqlite", path: "/app/data/data.db", storage: "container_layer" }] })).success).toBe(true);
    expect(TestResultSchema.safeParse(withFacts({ storage: [{ kind: "sqlite", path: "/app/data/data.db" }] })).success).toBe(false);
  });

  describe("facts.conditions 런타임 불변조건 (--test 직접 입력도 --handoff 와 같은 fail-closed)", () => {
    const issues = (facts: unknown) => {
      const r = TestResultSchema.safeParse(withFacts(facts));
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };

    it("정상 세 조건 입력은 통과한다", () => {
      expect(TestResultSchema.safeParse(withFacts({ ...uploadsEvidence, conditions: trio() })).success).toBe(true);
      expect(TestResultSchema.safeParse(withFacts({ conditions: [passAll("replace"), passAll("none"), passAll("restart")] })).success).toBe(true); // 순서는 자유
    });

    it("replace 누락 / 중복 / 빈 배열 거부", () => {
      expect(issues({ conditions: [passAll("none"), passAll("restart")] }).join("\n")).toMatch(/facts\.conditions: /);
      expect(issues({ conditions: [passAll("none"), passAll("restart"), passAll("restart")] }).join("\n")).toMatch(/조건이 빠졌습니다: replace|같은 조건이 두 번 있습니다: restart/);
      expect(issues({ conditions: [...trio(), passAll("none")] }).join("\n")).toMatch(/facts\.conditions/);
      expect(TestResultSchema.safeParse(withFacts({ conditions: [] })).success).toBe(false);
    });

    it("모르는 조건 이름 거부 (name 은 none / restart / replace 만)", () => {
      expect(issues({ conditions: [passAll("none"), passAll("restart"), passAll("replicas")] }).join("\n")).toMatch(/facts\.conditions\.2\.name/);
    });

    it("total=0 거부, matched > total 거부", () => {
      expect(issues({ conditions: trio({ ...passAll("replace"), total: 0, matched: 0 }) }).join("\n")).toMatch(/facts\.conditions\.2\.total/);
      expect(issues({ conditions: trio({ ...passAll("replace"), matched: 21 }) }).join("\n")).toMatch(/facts\.conditions\.2\.matched/);
    });

    it("failed 와 mismatches 수가 수치와 어긋나면 거부", () => {
      // failed=true, 20/19 인데 mismatches=[] → mismatches 수 불일치
      expect(issues({ conditions: trio({ ...replace16, mismatches: [] }) }).join("\n")).toMatch(/facts\.conditions\.2\.mismatches: mismatches 는 total - matched \(1\)개여야 하는데 0개/);
      expect(issues({ conditions: trio({ ...replace16, failed: false }) }).join("\n")).toMatch(/facts\.conditions\.2\.failed/);
      expect(issues({ conditions: trio({ ...passAll("replace"), failed: true }) }).join("\n")).toMatch(/facts\.conditions\.2\.failed/);
      expect(issues({ conditions: trio({ ...passAll("replace"), mismatches: [{ index: 1, request: "GET /" }] }) }).join("\n")).toMatch(/facts\.conditions\.2\.mismatches/);
    });

    it("같은 조건 안에서 mismatches[].index 가 중복되면 거부, 다른 조건끼리 같은 index 는 허용", () => {
      const me = (index: number) => ({ index, request: "GET /me" });
      // replace 안에서 11 이 두 번 (수는 total - matched 와 맞아서 기존 검사로는 잡히지 않는다)
      const dup = { name: "replace", total: 20, matched: 18, failed: true, mismatches: [me(11), me(11)] };
      expect(issues({ conditions: trio(dup) }).join("\n")).toMatch(/facts\.conditions\.2\.mismatches\.1\.index: 같은 조건 안에 요청 번호 11 가 두 번/);
      // 같은 기록을 조건마다 재생하므로 restart 와 replace 가 같은 11 번에서 어긋나는 것은 정상이다
      const restart11 = { name: "restart", total: 20, matched: 19, failed: true, mismatches: [me(11)] };
      const replace11 = { name: "replace", total: 20, matched: 19, failed: true, mismatches: [me(11)] };
      expect(TestResultSchema.safeParse(withFacts({ conditions: [passAll("none"), restart11, replace11] })).success).toBe(true);
      // none 안의 중복도 독립적으로 잡는다. 기존 "불일치 수 == total - matched" 검사는 그대로다
      const noneDup = { name: "none", total: 20, matched: 18, failed: true, mismatches: [me(3), me(3)] };
      expect(issues({ conditions: [noneDup, passAll("restart"), passAll("replace")] }).join("\n")).toMatch(/facts\.conditions\.0\.mismatches\.1\.index/);
      expect(issues({ conditions: trio({ ...dup, mismatches: [me(11)] }) }).join("\n")).toMatch(/mismatches 는 total - matched \(2\)개여야 하는데 1개/);
    });

    describe("mismatches[].related_* 는 facts.storage 와 facts.db / facts.writes_local_file 로 뒷받침돼야 한다 (R1c 가 맡긴 것을 R5 / R6 가 읽을 수 있게)", () => {
      const pii = PiiReportSchema.parse({ run_id: base.run_id, pii: [] });

      it("related_kind=local_upload 인데 storage 와 writes_local_file 근거가 없으면 거부 (근거 없는 related_kind 로 R1c 와 R6 를 모두 피하는 입력)", () => {
        const out = issues({ conditions: trio() });
        expect(out.join("\n")).toMatch(/facts\.conditions\.2\.mismatches\.0\.related_fact: facts\.storage 에 path=\/app\/uploads, kind=local_upload, storage=container_layer 인 항목이 없습니다/);
        expect(out.join("\n")).toMatch(/facts\.conditions\.2\.mismatches\.0\.related_fact: related_kind 가 local_upload 이면 facts\.writes_local_file 에 \/app\/uploads 가 있어야 합니다/);
        // storage 항목만 있고 writes_local_file 이 없어도 거부 (R6 가 읽는 것은 writes_local_file)
        expect(issues({ storage: uploadsEvidence.storage, conditions: trio() }).join("\n")).toMatch(/writes_local_file 에 \/app\/uploads 가 있어야/);
        // writes_local_file 만 있고 storage 항목이 없어도 거부
        expect(issues({ writes_local_file: ["/app/uploads"], conditions: trio() }).join("\n")).toMatch(/facts\.storage 에 path=\/app\/uploads/);
        // kind 나 storage 가 storage 항목과 다르면 같은 path 라도 거부
        expect(issues({ ...uploadsEvidence, storage: [{ kind: "local_file", path: "/app/uploads", storage: "container_layer" }], conditions: trio() }).join("\n")).toMatch(/facts\.storage 에 path=\/app\/uploads, kind=local_upload/);
        expect(issues({ ...uploadsEvidence, storage: [{ kind: "local_upload", path: "/app/uploads", storage: "volume" }], conditions: trio() }).join("\n")).toMatch(/storage=container_layer 인 항목이 없습니다/);
      });

      it("related_kind=sqlite 인데 facts.db 가 sqlite 가 아니면 거부", () => {
        const replace13 = { name: "replace", total: 20, matched: 19, failed: true, mismatches: [posts] };
        expect(issues({ storage: sqliteEvidence.storage, conditions: trio(replace13) }).join("\n")).toMatch(/facts\.conditions\.2\.mismatches\.0\.related_kind: related_kind 가 sqlite 이면 facts\.db 도 sqlite 여야 합니다 \(현재 \(없음\)\)/);
        expect(issues({ storage: sqliteEvidence.storage, db: "postgres", conditions: trio(replace13) }).join("\n")).toMatch(/facts\.db 도 sqlite 여야 합니다 \(현재 postgres\)/);
        expect(issues({ db: "sqlite", conditions: trio(replace13) }).join("\n")).toMatch(/facts\.storage 에 path=\/app\/data\/data\.db, kind=sqlite/);
      });

      it("대응하는 storage 항목과 db / writes_local_file 이 있으면 통과하고, R5 / R6 가 위치를 제한한다", () => {
        const both = { name: "replace", total: 20, matched: 18, failed: true, mismatches: [posts, uploads] };
        const facts = { storage: [...sqliteEvidence.storage, ...uploadsEvidence.storage], db: "sqlite", writes_local_file: ["/app/uploads"], conditions: trio(both) };
        expect(TestResultSchema.safeParse(withFacts(facts)).success, issues(facts).join("\n")).toBe(true);
        const plan = decide(TestResultSchema.parse(withFacts(facts)), pii, policy);
        expect(plan.decision).toBe("allow");
        expect(plan.targets).toEqual(["onprem"]);
        expect(plan.requires?.map((x) => x.id)).toEqual(["managed_db", "object_storage"]);
        // restart 조건의 related_* 도 같은 검증을 받는다 (조건을 가리지 않는다)
        const restart13 = { name: "restart", total: 20, matched: 19, failed: true, mismatches: [posts] };
        expect(issues({ ...uploadsEvidence, conditions: [passAll("none"), restart13, replace16] }).join("\n")).toMatch(/facts\.conditions\.1\.mismatches\.0\.related_kind: related_kind 가 sqlite/);
      });

      it("related_fact 힌트만 있고 kind / storage 가 없는 불일치는 그대로 받는다 (R1c 가 원인 미상으로 차단)", () => {
        const hintOnly = { name: "replace", total: 20, matched: 19, failed: true, mismatches: [{ index: 13, request: "GET /posts", related_fact: "/app/data/data.db" }] };
        expect(TestResultSchema.safeParse(withFacts({ conditions: trio(hintOnly) })).success).toBe(true);
        const plan = decide(TestResultSchema.parse(withFacts({ conditions: trio(hintOnly) })), pii, policy);
        expect(plan.decision).toBe("block");
        expect(plan.requires?.map((x) => x.id)).toContain("investigate_replace_failure");
        // kind 나 storage 중 하나만 있는 반쪽 조회값은 거부
        expect(issues({ ...sqliteEvidence, conditions: trio({ ...hintOnly, mismatches: [{ ...hintOnly.mismatches[0], related_kind: "sqlite" }] }) }).join("\n")).toMatch(/related_storage: related_kind 나 related_storage 가 있으면 related_fact, related_storage, related_kind 가 모두 있어야/);
        expect(issues({ ...sqliteEvidence, conditions: trio({ ...hintOnly, mismatches: [{ index: 13, request: "GET /posts", related_storage: "container_layer", related_kind: "sqlite" }] }) }).join("\n")).toMatch(/related_fact: related_kind 나 related_storage 가 있으면/);
      });
    });

    it("conditions 가 없는 기존 fixtures 는 그대로 통과하고 결과도 같다", () => {
      const pii = PiiReportSchema.parse({ run_id: base.run_id, pii: [] });
      expect(TestResultSchema.safeParse(base).success).toBe(true);
      expect(decide(TestResultSchema.parse(base), pii, policy).decision).toBe("allow");
      const failed = TestResultSchema.parse(JSON.parse(readFileSync(join(ROOT, "fixtures", "02-block-test-failed", "test_result.json"), "utf8")));
      const plan = decide(failed, { run_id: failed.run_id, pii: [] }, policy);
      expect(plan.decision).toBe("block");
      expect(plan.requires?.map((r) => r.id)).toEqual(["fix_tests", "managed_db"]);
    });
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
    expect(decide(parsed, pii, policy).targets).toEqual(["onprem", "cloud_run"]);
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
    expect(deploy["test.facts.conditions"]?.rules).toEqual(["R1", "R1b", "R1c"]);
    expect(deploy["test.facts.conditions[].failed"]?.rules).toEqual(["R1", "R1b", "R1c"]);
    expect(deploy["test.facts.conditions[].mismatches[].related_kind"]?.rules).toEqual(["R1c"]);
    expect(deploy["test.facts.conditions[].matched"]?.uses).toEqual(["reason"]);
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
    // 롤백 규칙의 reason 은 digest 를 넣지 않는다 (설명 함수가 따로 붙인다)
    expect(rollback["request.stable.digest"]).toBeUndefined();
    expect(Object.keys(rollback).sort()).toEqual(["request.stage", "request.state.db_migration_backward_compatible", "request.state.pii_written_onprem", "request.state.writes_since_cutover"]);
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
      then: { targets: ["onprem"] },
      reason: { ko: "express 는 온프레", ja: "expressはオンプレ {test.facts.framework}" },
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
    const custom = withRule({ id: "X9", if: { path: "test.facts.framework", eq: "express" }, then: { targets: ["onprem"] }, reason: "x" });
    const test = TestResultSchema.parse(withFacts({ db: "postgres", framework: "express" }));
    const plan = decide(test, PiiReportSchema.parse({ run_id: test.run_id, pii: [] }), custom);
    expect(plan.targets).toEqual(["onprem"]);
  });
});
