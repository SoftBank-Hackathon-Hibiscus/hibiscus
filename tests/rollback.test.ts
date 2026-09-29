import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { decideRollback } from "../src/rollback/engine.js";
import { DecisionLogSchema, PolicySchema, RollbackPlanSchema, RollbackRequestSchema, type RollbackRequest } from "../src/schema.js";

const ROOT = join(import.meta.dirname, "..");
const policy = PolicySchema.parse(parseYaml(readFileSync(join(ROOT, "policy.yaml"), "utf8")));
const STABLE = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

function loadRequest(name: string): RollbackRequest {
  return RollbackRequestSchema.parse(JSON.parse(readFileSync(join(ROOT, "fixtures", "rollback", `${name}.json`), "utf8")));
}
const matchedIds = (plan: ReturnType<typeof decideRollback>) => plan.rules.filter((r) => r.result === "matched").map((r) => r.id);

describe("decideRollback: 판단 규칙 5가지", () => {
  it("컷오버 전 실패 → keep_stable, serve_digest 는 stable (candidate 가 아님), 이후 규칙은 평가하지 않음", () => {
    const req = loadRequest("01-before-cutover");
    const plan = decideRollback(req, policy);

    expect(plan.decision).toBe("keep_stable");
    expect(plan.serve_digest).toBe(req.stable.digest);
    expect(plan.serve_digest).not.toBe(req.candidate.digest);
    expect(plan.targets).toEqual(req.stable.targets);
    expect(plan.failover_allowed).toBe(true);
    expect(plan.rules).toEqual([{ id: "RB1", result: "matched", reason: `컷오버 전 실패: 정상 버전(${STABLE}) 유지, 롤백 불필요` }]);
    expect(() => RollbackPlanSchema.parse(plan)).not.toThrow();
  });

  it("DB 마이그레이션 비호환 → manual_recovery, serve_digest null, targets 없음, failover false", () => {
    const plan = decideRollback(loadRequest("02-db-incompatible"), policy);

    expect(plan.decision).toBe("manual_recovery");
    expect(plan.serve_digest).toBeNull();
    expect(plan.targets).toEqual([]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["RB2"]);
    // RB2 에서 멈추므로 RB3/RB4 는 평가 목록에 없다
    expect(plan.rules.map((r) => r.id)).toEqual(["RB1", "RB2"]);
  });

  it("온프레에 개인정보 쓰임 (RB3) → rollback, targets [local], failover false", () => {
    const plan = decideRollback(loadRequest("03-pii-onprem"), policy);

    expect(plan.decision).toBe("rollback");
    expect(plan.serve_digest).toBe(STABLE);
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["RB3", "default"]);
    expect(plan.rules.find((r) => r.id === "RB3")?.reason).toContain("온프레 안에서만");
  });

  it("컷오버 후 쓰기 없음 (RB4) → stable 의 대상 그대로 [local, cloud_run], failover true", () => {
    const req = loadRequest("04-no-writes");
    const plan = decideRollback(req, policy);

    expect(plan.decision).toBe("rollback");
    expect(plan.serve_digest).toBe(STABLE);
    expect(plan.targets).toEqual(["local", "cloud_run"]);
    expect(plan.failover_allowed).toBe(true);
    expect(matchedIds(plan)).toEqual(["RB4"]);
    expect(plan.rules.find((r) => r.id === "RB4")?.reason).toBe(`컷오버 후 쓰기 없음: 정상 버전(${STABLE})의 대상 그대로 복귀`);
  });

  it("그 외 (컷오버 후 쓰기 있음, 문제 없음) → default: stable 로 복귀", () => {
    const req = loadRequest("05-default");
    const plan = decideRollback(req, policy);

    expect(plan.decision).toBe("rollback");
    expect(plan.serve_digest).toBe(STABLE);
    expect(plan.targets).toEqual(req.stable.targets);
    expect(plan.failover_allowed).toBe(true);
    expect(matchedIds(plan)).toEqual(["default"]);
    expect(plan.rules.map((r) => r.id)).toEqual(["RB1", "RB2", "RB3", "RB4", "default"]);
  });
});

describe("decideRollback: 병합", () => {
  it("개인정보 + DB 비호환이 동시에 있으면 manual_recovery 가 이긴다", () => {
    const plan = decideRollback(loadRequest("06-pii-and-db-incompatible"), policy);
    expect(plan.decision).toBe("manual_recovery");
    expect(plan.serve_digest).toBeNull();
    expect(plan.targets).toEqual([]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["RB2"]);
  });

  it("규칙 순서를 바꿔 개인정보 규칙이 먼저 걸려도 manual_recovery 가 이긴다", () => {
    const section = policy.rollback!;
    const reordered = PolicySchema.parse({
      ...policy,
      rollback: { ...section, rules: [section.rules[0], section.rules[2], section.rules[1], section.rules[3]] },
    });
    const plan = decideRollback(loadRequest("06-pii-and-db-incompatible"), reordered);
    expect(plan.decision).toBe("manual_recovery");
    expect(plan.targets).toEqual([]);
    expect(matchedIds(plan)).toEqual(["RB3", "RB2"]);
  });

  it("개인정보 + 쓰기 없음 → rollback 이되 대상은 좁혀진 [local], failover false (RB4 가 되돌리지 못함)", () => {
    const req = { ...loadRequest("03-pii-onprem"), state: { writes_since_cutover: false, pii_written_onprem: true, db_migration_backward_compatible: true } };
    const plan = decideRollback(req, policy);
    expect(plan.decision).toBe("rollback");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);
    expect(matchedIds(plan)).toEqual(["RB3", "RB4"]);
  });

  it("stable 이 cloud_run 에만 있었고 개인정보가 온프레에 쓰였으면 → 교집합이 비어 manual_recovery", () => {
    const req = { ...loadRequest("03-pii-onprem"), stable: { digest: STABLE, targets: ["cloud_run"] } };
    const plan = decideRollback(req, policy);
    expect(plan.decision).toBe("manual_recovery");
    expect(plan.serve_digest).toBeNull();
    expect(plan.targets).toEqual([]);
    expect(plan.rules.find((r) => r.id === "RB3")?.reason).toContain("허용된 복귀 대상이 없음");
  });

  it("좁히기는 stable 의 대상에서 시작한다 (규칙이 그 밖의 대상을 넣을 수 없다)", () => {
    const req = { ...loadRequest("05-default"), stable: { digest: STABLE, targets: ["local"] } };
    const custom = PolicySchema.parse({
      ...policy,
      rollback: {
        rules: [{ id: "X", if: { path: "request.stage", eq: "after_cutover" }, then: { targets: ["local", "cloud_run"] }, reason: "x" }],
        default: { decision: "rollback", failover_allowed: true, reason: "d" },
      },
    });
    const plan = decideRollback(req, custom);
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false); // cloud_run 이 없으므로
  });

  it("failover 는 false 가 이긴다: 앞 규칙이 false 로 정하면 뒤 규칙의 true 가 되돌리지 못한다", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rollback: {
        rules: [
          { id: "A", if: { path: "request.stage", eq: "after_cutover" }, then: { failover_allowed: false }, reason: "a" },
          { id: "B", if: { path: "request.stage", eq: "after_cutover" }, then: { failover_allowed: true }, reason: "b" },
        ],
        default: { decision: "rollback", failover_allowed: true, reason: "d" },
      },
    });
    const plan = decideRollback(loadRequest("05-default"), custom);
    expect(plan.targets).toEqual(["local", "cloud_run"]);
    expect(plan.failover_allowed).toBe(false);
  });

  it("default.failover_allowed 가 false 면 대상이 둘 다 있어도 false", () => {
    const custom = PolicySchema.parse({ ...policy, rollback: { ...policy.rollback!, default: { ...policy.rollback!.default, failover_allowed: false } } });
    const plan = decideRollback(loadRequest("04-no-writes"), custom);
    expect(plan.targets).toEqual(["local", "cloud_run"]);
    expect(plan.failover_allowed).toBe(false);
  });
});

describe("decideRollback: 결정성과 스키마", () => {
  it("같은 입력이면 같은 plan_hash, 입력이 다르면 다르다", () => {
    const req = loadRequest("05-default");
    const a = decideRollback(req, policy);
    const b = decideRollback(structuredClone(req), structuredClone(policy));
    expect(a).toEqual(b);
    expect(a.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    const other = decideRollback({ ...req, state: { ...req.state, writes_since_cutover: false } }, policy);
    expect(other.plan_hash).not.toBe(a.plan_hash);
  });

  it("rollback 섹션이 없는 정책이면 명확한 에러", () => {
    const { rollback: _omit, ...withoutRollback } = policy;
    const parsed = PolicySchema.parse(withoutRollback);
    expect(() => decideRollback(loadRequest("05-default"), parsed)).toThrow("rollback 섹션이 없습니다");
  });

  it("옛 이름(current/previous, keep_current)은 스키마에서 거부된다", () => {
    const req = loadRequest("05-default");
    const old = { run_id: req.run_id, app: req.app, stage: req.stage, current: req.candidate, previous: req.stable, state: req.state };
    expect(RollbackRequestSchema.safeParse(old).success).toBe(false);
    const oldPolicy = PolicySchema.safeParse({
      ...policy,
      rollback: { rules: [{ id: "RB1", if: { path: "request.stage", eq: "before_cutover" }, then: { decision: "keep_current" }, reason: "x" }], default: policy.rollback!.default },
    });
    expect(oldPolicy.success).toBe(false);
  });

  it("롤백 규칙의 targets 도 known_targets 검증을 받는다", () => {
    const result = PolicySchema.safeParse({
      ...policy,
      rollback: {
        rules: [{ id: "RB9", if: { path: "request.stage", eq: "after_cutover" }, then: { targets: ["onprem"] }, reason: "x" }],
        default: { decision: "rollback", failover_allowed: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.message)).toContain("알 수 없는 배포 대상: onprem (롤백 규칙 RB9)");
  });

  it("결정 기록은 kind 로 배포/롤백을 구분한다", () => {
    const plan = decideRollback(loadRequest("04-no-writes"), policy);
    const entry = DecisionLogSchema.parse({
      kind: "rollback",
      time: "2026-09-29T00:00:00.000Z",
      run_id: plan.run_id,
      digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      serve_digest: plan.serve_digest,
      decision: plan.decision,
      targets: plan.targets,
      failover_allowed: plan.failover_allowed,
      rule_ids: matchedIds(plan),
      plan_hash: plan.plan_hash,
    });
    expect(entry.kind).toBe("rollback");
    expect(DecisionLogSchema.safeParse({ ...entry, kind: "deploy" }).success).toBe(false); // deploy 에는 serve_digest 가 없고 decision 값도 다르다
  });
});
