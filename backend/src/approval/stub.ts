/**
 * stub 승인 제공자: 요청에서 받은 approver id 를 그대로 믿는다.
 * 인증이 없으므로 SIGNER_MODE=dry 에서만 허용하고, real 이면 거부한다.
 */
import type { SignerMode } from "../config.js";
import { type ApprovalProvider, type ApprovalRequest, ApprovalRefusedError, type ResolvedApproval } from "./provider.js";

export class StubApprovalProvider implements ApprovalProvider {
  readonly kind = "stub";

  constructor(private readonly signerMode: SignerMode) {}

  async resolve(req: ApprovalRequest): Promise<ResolvedApproval> {
    if (this.signerMode !== "dry") {
      throw new ApprovalRefusedError("stub 승인은 SIGNER_MODE=dry 에서만 허용한다. real 서명에는 인증된 승인 제공자가 필요하다 (미구현)");
    }
    return { approver: req.approver, provider: this.kind };
  }
}
