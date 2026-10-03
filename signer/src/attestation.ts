// 배포 증명서 (in-toto Statement). 이 이미지가 어떤 정책 결정·승인·감사 기록으로 서명됐는지를 서명된 문서로 이미지에 붙임.
// 배포 직전에 cosign verify-attestation --policy deploy.rego 로 서명과 "깨지면 안 되는 조건"을 같이 확인
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalize } from "./io.js";
import type { Approval, Plan, SignResult } from "./schema.js";
import { DigestSchema, PersonSchema, PlanHashSchema, RunIdSchema, SourceRevisionSchema } from "./schema.js";

export const DEPLOY_PREDICATE_TYPE = "https://hibiscus.lth.so/attestations/deploy-decision/v1";
export const DEFAULT_POLICY = fileURLToPath(new URL("../policy/deploy.rego", import.meta.url));
const SIGNER_VERSION = String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "0");

const Sha256OrNone = z.union([z.literal("none"), z.string().regex(/^[0-9a-f]{64}$/)]);

export const DeployPredicateSchema = z
  .strictObject({
    run_id: RunIdSchema,
    digest: DigestSchema,
    source_revision: SourceRevisionSchema.optional(),
    decision: z.enum(["allow", "needs_approval"]).describe("서명한 정책 결정. block 은 서명 안 해서 없음"),
    targets: z.array(z.string()).min(1),
    failover_allowed: z.boolean(),
    plan_hash: PlanHashSchema,
    plan_sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("plan.json 전체(키 정렬 JSON) 해시"),
    matched_rules: z.array(z.string()).describe("정책에서 걸린 규칙 id"),
    requester: PersonSchema,
    approver: PersonSchema.describe("승인자. allow 면 auto"),
    approved_at: z.string().optional().describe("사람 승인일 때 승인 시각"),
    approval_sha256: Sha256OrNone.describe("승인 기록(키 정렬 JSON) 해시. 자동 승인이면 none"),
    audit_head: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("감사 로그를 켰을 때 서명 직전 체인 끝"),
    signature_ref: z.string().min(1),
    signed_at: z.string(),
    signer: z.strictObject({ name: z.literal("hibiscus-signer"), version: z.string() }),
  })
  .describe("배포 증명서 predicate. in-toto Statement 의 predicate 로 이미지에 붙음");
export type DeployPredicate = z.infer<typeof DeployPredicateSchema>;

export interface PredicateInput {
  result: SignResult;
  plan: Plan;
  planSha256: string;
  approval?: Approval | undefined;
  approvalSha256: string;
  auditHead?: string | undefined;
}

export function buildPredicate(i: PredicateInput): DeployPredicate {
  // Plan 스키마의 rules 는 signer zod 에 없어서 형식을 직접 확인
  const rules = (i.plan as { rules?: unknown }).rules;
  const matched = Array.isArray(rules)
    ? rules.filter((r): r is { id: string; result: string } => !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" && (r as { result?: unknown }).result === "matched").map((r) => r.id)
    : [];
  return DeployPredicateSchema.parse({
    run_id: i.result.run_id,
    digest: i.result.digest,
    ...(i.result.source_revision !== undefined ? { source_revision: i.result.source_revision } : {}),
    decision: i.plan.decision,
    targets: i.result.targets,
    failover_allowed: i.result.failover_allowed,
    plan_hash: i.result.plan_hash,
    plan_sha256: i.planSha256,
    matched_rules: matched,
    requester: i.result.requester,
    approver: i.result.approver,
    ...(i.approval ? { approved_at: i.approval.approved_at } : {}),
    approval_sha256: i.approvalSha256,
    ...(i.auditHead !== undefined ? { audit_head: i.auditHead } : {}),
    signature_ref: i.result.signature_ref,
    signed_at: i.result.signed_at,
    signer: { name: "hibiscus-signer", version: SIGNER_VERSION },
  });
}

// sign_result 와 증명서가 같아야 하는 필드
const RESULT_FIELDS = ["run_id", "digest", "source_revision", "targets", "failover_allowed", "plan_hash", "requester", "approver", "signature_ref", "signed_at"] as const;

/**
 * verify-attestation 으로 확인된 Statement 중에 이 sign_result 와 같은 증명서가 있는지.
 * 있으면 그 predicate, 없으면 이유 문자열
 */
export function findDeployStatement(statements: readonly unknown[], result: SignResult): { ok: true; predicate: DeployPredicate } | { ok: false; detail: string } {
  const hex = result.digest.slice("sha256:".length);
  let reason = "배포 증명서가 없음";
  for (const s of statements) {
    const st = s as { predicateType?: unknown; subject?: unknown; predicate?: unknown };
    if (st.predicateType !== DEPLOY_PREDICATE_TYPE) continue;
    const subjects = Array.isArray(st.subject) ? (st.subject as Array<{ digest?: { sha256?: unknown } }>) : [];
    if (!subjects.some((sub) => sub?.digest?.sha256 === hex)) {
      reason = "증명서 대상 이미지(subject)가 sign_result.digest 와 다름";
      continue;
    }
    const parsed = DeployPredicateSchema.safeParse(st.predicate);
    if (!parsed.success) {
      reason = "증명서 내용 형식 오류";
      continue;
    }
    const differs = RESULT_FIELDS.find((k) => canonicalize(parsed.data[k]) !== canonicalize(result[k]));
    if (differs) {
      reason = `증명서와 sign_result 의 ${differs} 가 다름`;
      continue;
    }
    return { ok: true, predicate: parsed.data };
  }
  return { ok: false, detail: reason };
}
