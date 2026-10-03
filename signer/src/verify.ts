// sign_result.json 이 signer 가 서명한 그대로인지(verify), 감사 로그가 끊기지 않았는지(audit) 확인
import { fileURLToPath } from "node:url";
import { logAnnotations, signAnnotations } from "./annotations.js";
import { checkAuditChain, findSignedLine, readAuditFile, type AuditBreak } from "./audit.js";
import { imageRefOf, type ImageVerifier } from "./cosign.js";
import { canonicalize, parseWith, readJson, SignerError } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { SignResultSchema, type SignResult } from "./schema.js";

export const DEFAULT_PUBLIC_KEY = fileURLToPath(new URL("../keys/cosign.pub", import.meta.url));

export type VerifyReason = "dry_run" | "ref_invalid" | "repo_mismatch" | "plan_mismatch" | "audit_mismatch" | "signature_invalid";

export interface VerifyOptions {
  resultPath: string;
  verifier: ImageVerifier;
  /** 있으면 서명된 저장소가 이 값이어야 함 */
  imageRepo?: string;
  /** 있으면 plan 내용과 plan 파일 해시까지 확인 */
  planPath?: string;
  planSchemaPath?: string;
  /** 있으면 감사 로그 체인과 이 실행의 signed 줄(anchor)까지 확인 */
  auditPath?: string;
}

export type VerifyOutcome =
  | { code: 0; result: SignResult; imageRef: string; annotations: Record<string, string> }
  | { code: 1; reason: VerifyReason; detail: string };

// plan 과 sign_result 에 같이 있는 필드
const PLAN_FIELDS = ["run_id", "digest", "plan_hash", "source_revision", "targets", "failover_allowed"] as const;

const fail = (reason: VerifyReason, detail: string): VerifyOutcome => ({ code: 1, reason, detail });

export async function runVerify(o: VerifyOptions): Promise<VerifyOutcome> {
  const result = parseWith(SignResultSchema, readJson(o.resultPath, "sign_result"), "sign_result");

  const ref = result.signature_ref;
  if (ref.startsWith("dry-run:")) return fail("dry_run", "dry-run 결과라 실제 서명이 없음");
  if (!ref.startsWith("cosign:")) return fail("ref_invalid", `signature_ref 가 cosign: 으로 시작하지 않음: ${ref}`);
  const imageRef = ref.slice("cosign:".length);
  const at = imageRef.lastIndexOf("@");
  const repo = at < 0 ? "" : imageRef.slice(0, at);
  try {
    if (imageRefOf(repo, result.digest) !== imageRef) return fail("ref_invalid", `signature_ref 의 digest 가 sign_result.digest 와 다름: ${ref}`);
  } catch {
    return fail("ref_invalid", `signature_ref 형식 오류 (cosign:<저장소>@<digest>): ${ref}`);
  }
  if (o.imageRepo !== undefined && o.imageRepo !== repo) return fail("repo_mismatch", `서명된 저장소(${repo})가 지정한 저장소(${o.imageRepo})와 다름`);

  let planSha256: string | undefined;
  if (o.planPath !== undefined) {
    const loaded = loadPlan(o.planPath, o.planSchemaPath ?? DEFAULT_PLAN_SCHEMA);
    const differs = PLAN_FIELDS.find((k) => canonicalize(loaded.plan[k]) !== canonicalize(result[k]));
    if (differs) return fail("plan_mismatch", `plan 과 sign_result 의 ${differs} 가 다름`);
    planSha256 = loaded.planSha256;
  }

  let auditHead: string | undefined;
  if (o.auditPath !== undefined) {
    const check = checkAuditChain(readAuditFile(o.auditPath));
    if (!check.ok) return fail("audit_mismatch", `감사 로그 ${check.line}번째 줄 (${check.reason}): ${check.detail}`);
    const line = findSignedLine(check.lines, result);
    if (!line) return fail("audit_mismatch", "감사 로그에 이 서명 결과(signed 줄)가 없음");
    auditHead = line.anchor;
  }

  const annotations = signAnnotations(result, { planSha256, auditHead });
  try {
    await o.verifier.verify(imageRef, annotations);
  } catch (e) {
    if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") return fail("signature_invalid", e.message);
    throw e;
  }
  return { code: 0, result, imageRef, annotations };
}

export interface AuditVerifyOptions {
  auditPath: string;
  /** 있으면 signed 줄마다 이미지 서명의 audit_head 까지 확인 */
  verifier?: ImageVerifier;
}

export type AuditVerifyOutcome =
  | { code: 0; lines: number; head: string; images: number }
  | { code: 1; line: number; reason: AuditBreak | "signature_invalid"; detail: string };

export async function runAuditVerify(o: AuditVerifyOptions): Promise<AuditVerifyOutcome> {
  const check = checkAuditChain(readAuditFile(o.auditPath));
  if (!check.ok) return { code: 1, line: check.line, reason: check.reason, detail: check.detail };

  let images = 0;
  if (o.verifier) {
    for (const line of check.lines) {
      const ref = line.entry.signature_ref;
      // dry-run 은 실제 서명이 없어서 건너뜀
      if (line.entry.result !== "signed" || line.anchor === undefined || !ref?.startsWith("cosign:")) continue;
      try {
        await o.verifier.verify(ref.slice("cosign:".length), logAnnotations(line.entry, line.anchor));
      } catch (e) {
        if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") return { code: 1, line: line.seq, reason: "signature_invalid", detail: e.message };
        throw e;
      }
      images++;
    }
  }
  return { code: 0, lines: check.lines.length, head: check.head, images };
}
