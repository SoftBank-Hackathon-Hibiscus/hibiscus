// plan 읽기 → 결정 → 서명 → sign_result.json + kind: sign 기록.
// 거절이면 sign_result.json 을 안 남김 (이전 파일도 지움). plan 을 못 읽으면 run_id 를 몰라서 기록 없이 오류
import { existsSync, rmSync } from "node:fs";
import { signAnnotations } from "./annotations.js";
import { loadApproval } from "./approval.js";
import { imageRefOf, type ImageSigner } from "./cosign.js";
import { decideSign } from "./decide.js";
import { appendSignLog, SignerError, writeJson } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { SignResultSchema, type RefuseReason, type SignResult } from "./schema.js";

export interface SignOptions {
  planPath: string;
  requester: string;
  approvalPath?: string;
  imageRepo: string;
  outPath: string;
  logPath: string;
  signer: ImageSigner;
  planSchemaPath?: string;
  now?: () => Date;
}

export type SignOutcome =
  | { code: 0; result: SignResult }
  | { code: 1; reason: RefuseReason; detail: string }
  | { code: 2; reason: "sign_failed"; detail: string };

export async function runSign(o: SignOptions): Promise<SignOutcome> {
  const now = o.now ?? (() => new Date());
  if (existsSync(o.outPath)) rmSync(o.outPath);

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

  const decision = decideSign(plan, loaded.planSha256, o.requester, approval);
  if (!decision.ok) {
    appendSignLog(o.logPath, { ...base, result: "refused", approver: approval?.approver ?? null, reason: decision.reason, signature_ref: null }, now());
    return { code: 1, reason: decision.reason, detail: decision.detail };
  }

  // sign_result 의 서명 대상 필드 전부 + plan 파일 해시를 주석으로 붙임. 서명 뒤 targets 등을 바꾸면 verify 에서 걸림
  const claims = { ...base, targets: plan.targets, failover_allowed: plan.failover_allowed, approver: decision.approver };
  const annotations = signAnnotations(claims, { planSha256: loaded.planSha256 });

  let signatureRef: string;
  try {
    signatureRef = await o.signer.sign(imageRef, annotations);
  } catch (e) {
    appendSignLog(o.logPath, { ...base, result: "refused", approver: decision.approver, reason: "sign_failed", signature_ref: null }, now());
    const detail = e instanceof SignerError ? e.message : String(e);
    return { code: 2, reason: "sign_failed", detail };
  }

  const signedAt = now();
  const result = SignResultSchema.parse({
    ...claims,
    signature_ref: signatureRef,
    signed_at: signedAt.toISOString(),
  });
  writeJson(o.outPath, result);
  appendSignLog(o.logPath, { ...base, result: "signed", approver: decision.approver, reason: null, signature_ref: signatureRef }, signedAt);
  return { code: 0, result };
}
