// cosign 서명 주석. sign 과 verify 가 이 함수만 써서 서로 어긋나지 않게 함
import { SignerError } from "./io.js";
import { ANNOTATION_VALUE_RE, type SignLog, type SignResult } from "./schema.js";

/** 서명으로 보장하는 sign_result 필드 */
export type SignedFields = Pick<SignResult, "run_id" | "plan_hash" | "source_revision" | "targets" | "failover_allowed" | "requester" | "approver" | "signed_at">;

export interface AnnotationExtras {
  /** plan.json 전체 해시. plan 의 rules 등 나머지까지 묶음 */
  planSha256?: string | undefined;
  /** 서명 직전 감사 로그 체인 끝 hash */
  auditHead?: string | undefined;
  /** 승인 기록(approval.json, 키 정렬 JSON)의 sha256. 자동 승인이면 none */
  approvalSha256?: string | undefined;
  /** 서명한 저장소 (태그 없는 주소). 이미지와 서명을 다른 저장소로 복사해 쓰지 못하게 */
  imageRepo?: string | undefined;
  /** 승인 기록에 서명한 승인자 SSH 키 지문 (SHA256:…). 승인자 서명을 확인했을 때만 */
  approvalKey?: string | undefined;
}

/** 승인 기록이 없을 때(allow, approver auto) 주석 값 */
export const NO_APPROVAL = "none";

const SAFE_VALUE = ANNOTATION_VALUE_RE;

/** targets 를 항목마다 인코딩해서 + 로 연결. 순서 그대로 */
export function encodeTargets(targets: readonly string[]): string {
  try {
    return targets.map(encodeURIComponent).join("+");
  } catch {
    // 짝 없는 서로게이트 문자 등은 encodeURIComponent 가 URIError
    throw new SignerError("ANNOTATION_INVALID", `targets 에 인코딩할 수 없는 문자가 있음: ${JSON.stringify(targets)}`);
  }
}

/** 시각 같은 값 하나를 인코딩. 짝 없는 서로게이트는 SignerError 로 */
function encodeValue(name: string, value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new SignerError("ANNOTATION_INVALID", `${name} 에 인코딩할 수 없는 문자가 있음: ${JSON.stringify(value)}`);
  }
}

/** encodeTargets 의 반대. 빈 문자열이면 빈 목록 */
export function decodeTargets(value: string): string[] {
  if (value === "") return [];
  try {
    return value.split("+").map(decodeURIComponent);
  } catch {
    throw new SignerError("ANNOTATION_INVALID", `targets 주석을 풀 수 없음: ${value}`);
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
    // 서명 시각도 묶음 (sign_result 의 signed_at 만 고쳐서 유효기간 검사를 피하지 못하게). ISO 시각의 : 는 인코딩
    signed_at: encodeValue("signed_at", f.signed_at),
    ...(x.planSha256 !== undefined ? { plan_sha256: x.planSha256 } : {}),
    ...(x.auditHead !== undefined ? { audit_head: x.auditHead } : {}),
    ...(x.imageRepo !== undefined ? { image_repo: encodeImageRepo(x.imageRepo) } : {}),
    ...(x.approvalKey !== undefined ? { approval_key: encodeValue("approval_key", x.approvalKey) } : {}),
  });
}

/** image_repo 주석 값 (: / 를 인코딩) */
export function encodeImageRepo(repo: string): string {
  return encodeValue("image_repo", repo);
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
    signed_at: encodeValue("time", entry.time),
    audit_head: anchor,
  });
}

function checked(annotations: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(annotations)) {
    if (!SAFE_VALUE.test(value)) throw new SignerError("ANNOTATION_INVALID", `서명 주석 ${key} 값에 쓸 수 없는 문자가 있음: ${value}`);
  }
  return annotations;
}
