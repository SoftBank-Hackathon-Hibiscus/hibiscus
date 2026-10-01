/**
 * 사람 승인 제공자. needs_approval 인 run 에 대해 "누가 승인했는가" 를 확정한다.
 * requester·approver 를 어떻게 인증할지는 아직 정하지 않았다 (README 의 TBD 참고).
 */
import type { DeploymentRun } from "../models.js";

export interface ApprovalRequest {
  run: DeploymentRun;
  /** 요청에 담겨 온 승인자 id */
  approver: string;
}

export interface ResolvedApproval {
  approver: string;
  provider: string;
}

export class ApprovalRefusedError extends Error {}

export interface ApprovalProvider {
  readonly kind: string;
  resolve(req: ApprovalRequest): Promise<ResolvedApproval>;
}
