// sign_result.json 이 signer 가 서명한 그대로인지 확인. 서명 주석 전부를 cosign verify -a 로 대조
import { fileURLToPath } from "node:url";
import { signAnnotations } from "./annotations.js";
import { imageRefOf, type ImageVerifier } from "./cosign.js";
import { canonicalize, parseWith, readJson, SignerError } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { SignResultSchema, type SignResult } from "./schema.js";

export const DEFAULT_PUBLIC_KEY = fileURLToPath(new URL("../keys/cosign.pub", import.meta.url));

export type VerifyReason = "dry_run" | "ref_invalid" | "repo_mismatch" | "plan_mismatch" | "signature_invalid";

export interface VerifyOptions {
  resultPath: string;
  verifier: ImageVerifier;
  /** 있으면 서명된 저장소가 이 값이어야 함 */
  imageRepo?: string;
  /** 있으면 plan 내용과 plan 파일 해시까지 확인 */
  planPath?: string;
  planSchemaPath?: string;
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

  const annotations = signAnnotations(result, { planSha256 });
  try {
    await o.verifier.verify(imageRef, annotations);
  } catch (e) {
    if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") return fail("signature_invalid", e.message);
    throw e;
  }
  return { code: 0, result, imageRef, annotations };
}
