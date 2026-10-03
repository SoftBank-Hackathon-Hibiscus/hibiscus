// plan 읽기 → 결정 → 서명 → sign_result.json + kind: sign 기록 (+ 감사 로그 체인).
// 거절이면 sign_result.json 을 안 남김 (이전 파일도 지움). plan 을 못 읽으면 run_id 를 몰라서 기록 없이 오류
import { existsSync, rmSync } from "node:fs";
import { NO_APPROVAL, signAnnotations } from "./annotations.js";
import { loadApproval } from "./approval.js";
import { appendAudit, readAuditHead, type AuditOptions } from "./audit.js";
import { imageRefOf, type ImageSigner, type ImageVerifier } from "./cosign.js";
import { decideSign } from "./decide.js";
import { appendSignLog, canonicalize, sha256Hex, SignerError, signLogLine, writeJson } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { AUTO_APPROVER, PersonSchema, SignResultSchema, type RefuseReason, type SignLog, type SignResult } from "./schema.js";

export interface SignOptions {
  planPath: string;
  requester: string;
  approvalPath?: string;
  imageRepo: string;
  outPath: string;
  logPath: string;
  signer: ImageSigner;
  planSchemaPath?: string;
  /** 있으면 결정마다 감사 로그(해시 체인)에도 한 줄 */
  auditPath?: string;
  audit?: AuditOptions;
  /** 승인 유효시간(ms). 없으면 오래된 승인도 받음 */
  approvalTtlMs?: number;
  /** 있으면 서명 직후 이 확인기(고정한 공개키)로 다시 확인. 실패하면 sign_result 를 안 남김 */
  selfVerifier?: ImageVerifier;
  now?: () => Date;
}

export type SignOutcome =
  | { code: 0; result: SignResult }
  | { code: 1; reason: RefuseReason; detail: string }
  | { code: 2; reason: "sign_failed"; detail: string };

export async function runSign(o: SignOptions): Promise<SignOutcome> {
  const now = o.now ?? (() => new Date());
  if (existsSync(o.outPath)) rmSync(o.outPath);

  // 요청자 id 를 먼저 확인. 형식이 틀리면 cosign 서명만 레지스트리에 남고 기록 없이 끝나던 문제 막음
  if (!PersonSchema.safeParse(o.requester).success) throw new SignerError("REQUESTER_INVALID", `요청자 id 형식 오류 (영문·숫자·._- 1~64자): ${o.requester}`);
  const loaded = loadPlan(o.planPath, o.planSchemaPath ?? DEFAULT_PLAN_SCHEMA);
  const { plan } = loaded;
  const approval = o.approvalPath ? loadApproval(o.approvalPath) : undefined;
  const imageRef = imageRefOf(o.imageRepo, plan.digest);
  const base = {
    run_id: plan.run_id,
    digest: plan.digest,
    ...(plan.source_revision !== undefined ? { source_revision: plan.source_revision } : {}),
    plan_hash: plan.plan_hash,
    requester: o.requester,
  };

  // 거절·서명 실패 기록. 감사 로그에는 anchor 없이
  const refused = async (line: SignLog) => {
    appendSignLog(o.logPath, line);
    if (o.auditPath) await appendAudit(o.auditPath, line, undefined, o.audit);
  };

  const decision = decideSign(plan, loaded.planSha256, o.requester, approval, {
    now: now(),
    ...(o.approvalTtlMs !== undefined ? { approvalTtlMs: o.approvalTtlMs } : {}),
  });
  if (!decision.ok) {
    await refused(signLogLine({ ...base, result: "refused", approver: approval?.approver ?? null, reason: decision.reason, signature_ref: null }, now()));
    return { code: 1, reason: decision.reason, detail: decision.detail };
  }

  // sign_result 의 서명 대상 필드 전부 + plan 파일 해시를 주석으로 붙임. 서명 뒤 targets 등을 바꾸면 verify 에서 걸림
  const claims = { ...base, targets: plan.targets, failover_allowed: plan.failover_allowed, approver: decision.approver };
  // 감사 로그를 켰으면 서명 직전 체인 끝을 서명에도 남김 (체인을 통째로 다시 계산하면 서명과 안 맞게)
  const auditHead = o.auditPath ? await readAuditHead(o.auditPath, o.audit) : undefined;
  // 사람 승인이면 그 승인 기록(누가, 언제)까지 서명에 묶음. 자동 승인이면 none
  const approvalSha256 = decision.approver === AUTO_APPROVER || !approval ? NO_APPROVAL : sha256Hex(canonicalize(approval));
  const annotations = signAnnotations(claims, { planSha256: loaded.planSha256, auditHead, approvalSha256 });

  let signatureRef: string;
  try {
    signatureRef = await o.signer.sign(imageRef, annotations);
  } catch (e) {
    await refused(signLogLine({ ...base, result: "refused", approver: decision.approver, reason: "sign_failed", signature_ref: null }, now()));
    const detail = e instanceof SignerError ? e.message : String(e);
    return { code: 2, reason: "sign_failed", detail };
  }

  // 서명 직후 자기 확인. 키가 공개키와 안 맞거나 주석이 안 붙었으면 여기서 멈춤 (배포 때가 아니라 서명 순간에 잡게)
  if (o.selfVerifier) {
    try {
      await o.selfVerifier.verify(imageRef, annotations);
    } catch (e) {
      await refused(signLogLine({ ...base, result: "refused", approver: decision.approver, reason: "sign_failed", signature_ref: null }, now()));
      return { code: 2, reason: "sign_failed", detail: `서명 직후 확인 실패: ${e instanceof SignerError ? e.message : String(e)}` };
    }
  }

  const signedAt = now();
  const result = SignResultSchema.parse({
    ...claims,
    signature_ref: signatureRef,
    signed_at: signedAt.toISOString(),
  });
  const line = signLogLine({ ...base, result: "signed", approver: decision.approver, reason: null, signature_ref: signatureRef }, signedAt);
  // 감사 로그를 못 쓰면 sign_result 도 안 남김 (기록 없는 서명 결과로 배포되지 않게)
  if (o.auditPath) await appendAudit(o.auditPath, line, auditHead, o.audit);
  writeJson(o.outPath, result);
  appendSignLog(o.logPath, line);
  return { code: 0, result };
}
