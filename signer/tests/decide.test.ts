import { describe, expect, it } from "vitest";
import { createApproval } from "../src/approval.js";
import { decideSign } from "../src/decide.js";
import { loadPlan } from "../src/plan.js";
import { NOW, plan } from "./helpers.js";

describe("decideSign", () => {
  it("block 이면 서명 안 함", () => {
    const { plan: p, planSha256 } = loadPlan(plan("block"));
    expect(decideSign(p, planSha256, "alice")).toMatchObject({ ok: false, reason: "policy_block" });
  });

  it("allow 면 사람 승인 없이 서명, approver 는 auto", () => {
    const { plan: p, planSha256 } = loadPlan(plan("allow"));
    expect(decideSign(p, planSha256, "alice")).toEqual({ ok: true, approver: "auto" });
  });

  it("allow 라도 targets 가 비면 서명 안 함", () => {
    const { plan: p, planSha256 } = loadPlan(plan("allow"));
    expect(decideSign({ ...p, targets: [] }, planSha256, "alice")).toMatchObject({ ok: false, reason: "no_targets" });
  });

  describe("needs_approval", () => {
    const loaded = loadPlan(plan("needs-approval"));
    const { plan: p, planSha256 } = loaded;

    it("승인 기록이 없으면 서명 안 함", () => {
      expect(decideSign(p, planSha256, "alice")).toMatchObject({ ok: false, reason: "approval_missing" });
    });

    it("다른 사람이 승인하면 그 사람이 approver", () => {
      const approval = createApproval(loaded, "alice", "bob", NOW);
      expect(decideSign(p, planSha256, "alice", approval)).toEqual({ ok: true, approver: "bob" });
    });

    it("본인 승인 기록은 인정하지 않음", () => {
      const approval = { ...createApproval(loaded, "alice", "bob", NOW), approver: "alice" };
      expect(decideSign(p, planSha256, "alice", approval)).toMatchObject({ ok: false, reason: "self_approval" });
    });

    it("승인 기록의 요청자와 지금 요청자가 다르면 서명 안 함", () => {
      const approval = createApproval(loaded, "alice", "bob", NOW);
      expect(decideSign(p, planSha256, "mallory", approval)).toMatchObject({ ok: false, reason: "requester_mismatch" });
    });

    it.each([
      ["digest", { digest: `sha256:${"0".repeat(64)}` }],
      ["plan_hash", { plan_hash: "f".repeat(64) }],
      ["run_id", { run_id: "r-other" }],
    ])("승인 뒤 %s 가 바뀌면 서명 안 함", (_field, patch) => {
      const approval = createApproval(loaded, "alice", "bob", NOW);
      expect(decideSign({ ...p, ...patch }, planSha256, "alice", approval)).toMatchObject({ ok: false, reason: "approval_mismatch" });
    });

    it("plan_hash 는 그대로인데 plan 내용(targets 등)이 바뀌면 서명 안 함", () => {
      const approval = createApproval(loaded, "alice", "bob", NOW);
      expect(decideSign(p, "e".repeat(64), "alice", approval)).toMatchObject({ ok: false, reason: "approval_mismatch" });
    });
  });
});

describe("createApproval", () => {
  it("요청자 본인은 승인 기록을 만들 수 없음", () => {
    expect(() => createApproval(loadPlan(plan("needs-approval")), "alice", "alice", NOW)).toThrow(/본인/);
  });

  it("needs_approval 이 아니면 승인 기록을 만들지 않음", () => {
    expect(() => createApproval(loadPlan(plan("allow")), "alice", "bob", NOW)).toThrow(/needs_approval/);
  });

  it("approver 에 auto 는 쓸 수 없음", () => {
    expect(() => createApproval(loadPlan(plan("needs-approval")), "alice", "auto", NOW)).toThrow();
  });
});
