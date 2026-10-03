// sign_result.json 이 signer 가 서명한 그대로인지(verify), 감사 로그가 끊기지 않았는지(audit) 확인
import { fileURLToPath } from "node:url";
import { logAnnotations, NO_APPROVAL, signAnnotations } from "./annotations.js";
import { loadApproval } from "./approval.js";
import { checkAuditChain, findSignedLine, GENESIS, readAuditFile, type AuditBreak } from "./audit.js";
import { imageRefOf, type ImageVerifier } from "./cosign.js";
import { canonicalize, parseWith, readJson, sha256Hex, SignerError } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { AUTO_APPROVER, SignResultSchema, type AuditLine, type SignResult } from "./schema.js";

export const DEFAULT_PUBLIC_KEY = fileURLToPath(new URL("../keys/cosign.pub", import.meta.url));

export type VerifyReason = "dry_run" | "ref_invalid" | "repo_mismatch" | "plan_mismatch" | "approval_mismatch" | "audit_mismatch" | "signature_invalid";

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
  /** 있으면 이 승인 기록으로 서명했는지까지 확인 (사람 승인일 때) */
  approvalPath?: string;
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

  // 자동 승인 결과는 항상 "승인 기록 없음(none)"으로 서명돼 있어야 함. 사람 승인은 승인 기록을 주면 그 해시까지 확인
  let approvalSha256: string | undefined = result.approver === AUTO_APPROVER ? NO_APPROVAL : undefined;
  if (o.approvalPath !== undefined) {
    if (result.approver === AUTO_APPROVER) return fail("approval_mismatch", "자동 승인(auto) 결과인데 승인 기록을 줌");
    const approval = loadApproval(o.approvalPath);
    const differs = (["run_id", "digest", "plan_hash", "requester", "approver"] as const).find((k) => approval[k] !== result[k]);
    if (differs) return fail("approval_mismatch", `승인 기록과 sign_result 의 ${differs} 가 다름`);
    approvalSha256 = sha256Hex(canonicalize(approval));
  }

  let auditHead: string | undefined;
  if (o.auditPath !== undefined) {
    const check = checkAuditChain(readAuditFile(o.auditPath));
    if (!check.ok) return fail("audit_mismatch", `감사 로그 ${check.line}번째 줄 (${check.reason}): ${check.detail}`);
    const line = findSignedLine(check.lines, result);
    if (!line) return fail("audit_mismatch", "감사 로그에 이 서명 결과(signed 줄)가 없음");
    auditHead = line.anchor;
  }

  const annotations = signAnnotations(result, { planSha256, auditHead, approvalSha256 });
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
  /** 있으면 레지스트리의 이미지 서명과 감사 로그를 맞춰 봄 */
  verifier?: ImageVerifier;
  /** 서명 줄이 없는 digest(거절 줄)도 이 저장소에서 서명을 찾음. 서명 줄을 거절로 바꿔치기한 것을 잡으려면 필요 */
  imageRepo?: string;
}

export type AuditImageReason = "ref_invalid" | "signature_invalid" | "unlogged_signature";

export type AuditVerifyOutcome =
  | { code: 0; lines: number; head: string; signed: number; images: number }
  | { code: 1; line: number; reason: AuditBreak | AuditImageReason; detail: string };

/**
 * 1) 체인이 이어지는지 2) (verifier 가 있으면) signed 줄마다 그 내용·anchor 와 맞는 이미지 서명이 있는지
 * 3) 반대로 레지스트리에 있는 audit_head 서명이 전부 감사 로그의 signed 줄과 맞는지 (signed 줄을 지우거나 거절로 바꾼 것)
 */
export async function runAuditVerify(o: AuditVerifyOptions): Promise<AuditVerifyOutcome> {
  const check = checkAuditChain(readAuditFile(o.auditPath));
  if (!check.ok) return { code: 1, line: check.line, reason: check.reason, detail: check.detail };
  const { lines, head } = check;
  if (!o.verifier) return { code: 0, lines: lines.length, head, signed: 0, images: 0 };

  // signed 줄의 서명 위치가 그 줄 digest 의 이미지인지 (옵션처럼 생긴 값, 다른 이미지 차단)
  const signedAt = new Map<string, AuditLine[]>();
  const repos = new Set<string>(o.imageRepo !== undefined ? [o.imageRepo] : []);
  for (const line of lines) {
    const ref = line.entry.signature_ref;
    if (line.entry.result !== "signed" || ref === null || ref.startsWith("dry-run:")) continue;
    const imageRef = ref.startsWith("cosign:") ? ref.slice("cosign:".length) : "";
    const repo = imageRef.slice(0, Math.max(0, imageRef.lastIndexOf("@")));
    let expected: string | undefined;
    try {
      expected = imageRefOf(repo, line.entry.digest);
    } catch {
      expected = undefined;
    }
    if (expected === undefined || expected !== imageRef) {
      return { code: 1, line: line.seq, reason: "ref_invalid", detail: `signature_ref 가 이 줄 digest 의 이미지가 아님: ${ref}` };
    }
    repos.add(repo);
    signedAt.set(imageRef, [...(signedAt.get(imageRef) ?? []), line]);
  }
  if (repos.size === 0 && lines.length > 0) {
    throw new SignerError("ARG_MISSING", "감사 로그에 서명 줄이 없어서 이미지 저장소를 모름. --image-repo 를 주세요");
  }

  // 확인할 이미지: signed 줄 이미지 + 모든 줄 digest × 알고 있는 저장소
  const refs = new Set(signedAt.keys());
  for (const line of lines) for (const repo of repos) refs.add(imageRefOf(repo, line.entry.digest));
  const lineOfHash = new Map<string, number>([[GENESIS, 0], ...lines.map((l) => [l.hash, l.seq] as const)]);
  const matches = (sig: Record<string, string>, line: AuditLine) =>
    line.anchor !== undefined && Object.entries(logAnnotations(line.entry, line.anchor)).every(([k, v]) => sig[k] === v);

  let images = 0;
  for (const imageRef of [...refs].sort()) {
    let sigs: Array<Record<string, string>>;
    try {
      sigs = await o.verifier.signatures(imageRef);
    } catch (e) {
      if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") {
        return { code: 1, line: signedAt.get(imageRef)?.[0]?.seq ?? 0, reason: "signature_invalid", detail: e.message };
      }
      throw e;
    }
    const logged = signedAt.get(imageRef) ?? [];
    for (const line of logged) {
      if (!sigs.some((sig) => matches(sig, line))) {
        return { code: 1, line: line.seq, reason: "signature_invalid", detail: `이 줄 내용·anchor 와 맞는 이미지 서명이 없음: ${imageRef}` };
      }
    }
    for (const sig of sigs) {
      const anchor = sig.audit_head;
      if (anchor === undefined) continue; // 감사 로그를 안 켜고 한 서명
      if (!logged.some((line) => matches(sig, line))) {
        const at = lineOfHash.get(anchor);
        return {
          code: 1,
          line: at === undefined ? 0 : at + 1,
          reason: "unlogged_signature",
          detail: `감사 로그에 없는 서명 (run_id=${sig.run_id ?? "?"}, audit_head=${anchor.slice(0, 12)}…): ${imageRef}`,
        };
      }
    }
    images++;
  }
  return { code: 0, lines: lines.length, head, signed: [...signedAt.values()].reduce((n, ls) => n + ls.length, 0), images };
}
