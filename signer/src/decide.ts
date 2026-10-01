// block 거절, allow 바로 서명(approver auto), needs_approval 은 다른 사람 승인 기록이 지금 plan 과 맞을 때만.
// targets 는 다시 판단하지 않고 plan 값 그대로
import { AUTO_APPROVER, type Approval, type Plan, type RefuseReason } from "./schema.js";

export type SignDecision =
  | { ok: true; approver: string }
  | { ok: false; reason: RefuseReason; detail: string };

const refuse = (reason: RefuseReason, detail: string): SignDecision => ({ ok: false, reason, detail });

export function decideSign(plan: Plan, planSha256: string, requester: string, approval?: Approval): SignDecision {
  if (plan.decision === "block") return refuse("policy_block", "정책 결정이 block 이라 서명하지 않음");
  if (plan.targets.length === 0) return refuse("no_targets", "배포 대상(targets)이 비어 있어 서명하지 않음");
  if (plan.decision === "allow") return { ok: true, approver: AUTO_APPROVER };

  if (!approval) return refuse("approval_missing", "needs_approval 인데 승인 기록이 없음");
  if (
    approval.run_id !== plan.run_id ||
    approval.digest !== plan.digest ||
    approval.plan_hash !== plan.plan_hash ||
    approval.plan_sha256 !== planSha256
  ) {
    return refuse("approval_mismatch", "승인한 plan 이나 이미지와 지금 plan 이 다름 (승인 뒤 바뀜)");
  }
  if (approval.requester !== requester) return refuse("requester_mismatch", `승인 기록의 요청자(${approval.requester})와 지금 요청자(${requester})가 다름`);
  if (approval.approver === approval.requester) return refuse("self_approval", "요청자 본인 승인은 인정하지 않음");
  return { ok: true, approver: approval.approver };
}
