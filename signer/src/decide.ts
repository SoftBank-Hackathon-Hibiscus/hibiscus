// block 거절, allow 바로 서명(approver auto), needs_approval 은 다른 사람 승인 기록이 지금 plan 과 맞을 때만.
// 승인 유효시간을 주면 오래된 승인도 거절. targets 는 다시 판단하지 않고 plan 값 그대로
import { AUTO_APPROVER, type Approval, type Plan, type RefuseReason } from "./schema.js";

export type SignDecision =
  | { ok: true; approver: string }
  | { ok: false; reason: RefuseReason; detail: string };

export interface DecideOptions {
  /** 승인 유효시간(ms). 없으면 시간은 안 봄 */
  approvalTtlMs?: number;
  now?: Date;
}

// 승인 시각이 이보다 더 미래면 시계가 틀렸거나 고친 기록으로 봄
const CLOCK_SKEW_MS = 60_000;

const refuse = (reason: RefuseReason, detail: string): SignDecision => ({ ok: false, reason, detail });

export function decideSign(plan: Plan, planSha256: string, requester: string, approval?: Approval, o: DecideOptions = {}): SignDecision {
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
  if (o.approvalTtlMs !== undefined) {
    const approvedAt = Date.parse(approval.approved_at);
    const age = (o.now ?? new Date()).getTime() - approvedAt;
    const ttlMin = Math.round(o.approvalTtlMs / 60_000);
    if (Number.isNaN(approvedAt)) return refuse("approval_expired", `승인 시각을 읽을 수 없음: ${approval.approved_at}`);
    if (age < -CLOCK_SKEW_MS) return refuse("approval_expired", `승인 시각이 미래임: ${approval.approved_at}`);
    if (age > o.approvalTtlMs) return refuse("approval_expired", `승인한 지 ${Math.floor(age / 60_000)}분 지남 (유효 ${ttlMin}분)`);
  }
  return { ok: true, approver: approval.approver };
}
