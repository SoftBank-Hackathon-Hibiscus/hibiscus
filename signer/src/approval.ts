// needs_approval 승인 기록. run_id·digest·plan_hash·plan 해시가 지금 plan 과 다 맞아야 쓸 수 있음
import { parseWith, readJson, SignerError } from "./io.js";
import type { LoadedPlan } from "./plan.js";
import { ApprovalSchema, type Approval } from "./schema.js";

export function createApproval(loaded: LoadedPlan, requester: string, approver: string, now: Date): Approval {
  const { plan, planSha256 } = loaded;
  if (plan.decision !== "needs_approval") {
    throw new SignerError("APPROVAL_NOT_NEEDED", `decision 이 ${plan.decision} 라 승인 기록을 만들지 않음 (needs_approval 일 때만)`);
  }
  if (approver === requester) throw new SignerError("SELF_APPROVAL", "요청자 본인은 승인할 수 없음");
  return parseWith(
    ApprovalSchema,
    {
      run_id: plan.run_id,
      digest: plan.digest,
      plan_hash: plan.plan_hash,
      plan_sha256: planSha256,
      requester,
      approver,
      approved_at: now.toISOString(),
    },
    "approval",
  );
}

export function loadApproval(path: string): Approval {
  return parseWith(ApprovalSchema, readJson(path, "approval"), "approval");
}
