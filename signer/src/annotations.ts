// cosign 서명 주석. sign 과 verify 가 이 함수만 써서 서로 어긋나지 않게 함
import { SignerError } from "./io.js";
import type { SignLog, SignResult } from "./schema.js";

/** 서명으로 보장하는 sign_result 필드 */
export type SignedFields = Pick<SignResult, "run_id" | "plan_hash" | "source_revision" | "targets" | "failover_allowed" | "requester" | "approver">;

export interface AnnotationExtras {
  /** plan.json 전체 해시. plan 의 rules 등 나머지까지 묶음 */
  planSha256?: string | undefined;
  /** 서명 직전 감사 로그 체인 끝 hash */
  auditHead?: string | undefined;
  /** 승인 기록(approval.json, 키 정렬 JSON)의 sha256. 자동 승인이면 none */
  approvalSha256?: string | undefined;
}

/** 승인 기록이 없을 때(allow, approver auto) 주석 값 */
export const NO_APPROVAL = "none";

// cosign -a 는 쉼표로 값을 나누고 = 가 두 번이면 거절함. encodeURIComponent 결과와 구분자 + 만 허용
const SAFE_VALUE = /^[A-Za-z0-9._~%!'()*+-]*$/;

/** targets 를 항목마다 인코딩해서 + 로 연결. 순서 그대로 */
export function encodeTargets(targets: readonly string[]): string {
  try {
    return targets.map(encodeURIComponent).join("+");
  } catch {
    // 짝 없는 서로게이트 문자 등은 encodeURIComponent 가 URIError
    throw new SignerError("ANNOTATION_INVALID", `targets 에 인코딩할 수 없는 문자가 있음: ${JSON.stringify(targets)}`);
  }
}

/** plan 에 source_revision 이 없을 때 주석 값. hex 가 아니라서 실제 커밋 SHA 와 안 겹침 */
export const NO_SOURCE_REVISION = "none";

export function signAnnotations(f: SignedFields, x: AnnotationExtras = {}): Record<string, string> {
  return checked({
    run_id: f.run_id,
    plan_hash: f.plan_hash,
    // 없어도 none 으로 항상 붙임. 서명 뒤 sign_result 에서 source_revision 을 지워도 verify 에서 걸리게
    source_revision: f.source_revision ?? NO_SOURCE_REVISION,
    targets: encodeTargets(f.targets),
    failover_allowed: String(f.failover_allowed),
    requester: f.requester,
    approver: f.approver,
    ...(x.approvalSha256 !== undefined ? { approval_sha256: x.approvalSha256 } : {}),
    ...(x.planSha256 !== undefined ? { plan_sha256: x.planSha256 } : {}),
    ...(x.auditHead !== undefined ? { audit_head: x.auditHead } : {}),
  });
}

/** 감사 로그 signed 줄로 확인할 수 있는 주석만 (SignLog 에 targets 가 없음) */
export function logAnnotations(entry: SignLog, anchor: string): Record<string, string> {
  if (entry.approver === null) throw new SignerError("ANNOTATION_INVALID", "signed 줄에 approver 가 없음");
  return checked({
    run_id: entry.run_id,
    plan_hash: entry.plan_hash,
    source_revision: entry.source_revision ?? NO_SOURCE_REVISION,
    requester: entry.requester,
    approver: entry.approver,
    audit_head: anchor,
  });
}

function checked(annotations: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(annotations)) {
    if (!SAFE_VALUE.test(value)) throw new SignerError("ANNOTATION_INVALID", `서명 주석 ${key} 값에 쓸 수 없는 문자가 있음: ${value}`);
  }
  return annotations;
}
