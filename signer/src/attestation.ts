// 배포 증명서 (in-toto Statement). 이 이미지가 어떤 정책 결정·승인·감사 기록으로 서명됐는지를 서명된 문서로 이미지에 붙임.
// 배포 직전에 cosign verify-attestation --policy deploy.rego 로 서명과 "깨지면 안 되는 조건"을 같이 확인
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { canonicalize, parseWith, readJson, sha256Hex, SignerError } from "./io.js";
import type { Approval, Plan, SignResult } from "./schema.js";
import { DigestSchema, PersonSchema, PlanHashSchema, RunIdSchema, SourceRevisionSchema } from "./schema.js";

export const DEPLOY_PREDICATE_TYPE = "https://hibiscus.lth.so/attestations/deploy-decision/v1";
export const DEFAULT_POLICY = fileURLToPath(new URL("../policy/deploy.rego", import.meta.url));
const SIGNER_VERSION = String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "0");

const Sha256OrNone = z.union([z.literal("none"), z.string().regex(/^[0-9a-f]{64}$/)]);

// 시험 결과(test_result.json)는 파트 사이 공개 계약. 스키마를 못 읽으면 증명서에 넣지 않음 (Plan 과 같은 방식)
export const DEFAULT_TEST_SCHEMA = fileURLToPath(new URL("../../contracts/TestResult.schema.json", import.meta.url));

const ConditionSchema = z.strictObject({ name: z.string(), total: z.int().min(0), matched: z.int().min(0) });

export const TestEvidenceSchema = z
  .strictObject({
    sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("test_result.json 전체(키 정렬 JSON) 해시"),
    passed: z.boolean(),
    match: z.strictObject({ total: z.int().min(0), matched: z.int().min(0) }),
    conditions: z.array(ConditionSchema).describe("조건별(정상·재시작·교체) 재생 결과. 시험 결과에 없으면 빈 배열"),
  })
  .describe("이 이미지를 무엇으로 시험했는지. 증명서에 넣어서 시험 → 정책 → 승인 → 서명을 한 문서로 이음");
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

// 증명서에 필요한 필드만. 전체 검사는 TestResult.schema.json
const TestResultFieldsSchema = z.looseObject({
  run_id: RunIdSchema,
  digest: DigestSchema,
  passed: z.boolean(),
  match: z.looseObject({ total: z.int(), matched: z.int() }),
  facts: z.looseObject({ conditions: z.array(z.looseObject({ name: z.string(), total: z.int(), matched: z.int() })).optional() }).optional(),
});

/** test_result.json 을 계약 스키마로 검사하고 증명서용 요약을 만듦. run_id·digest 가 서명할 plan 과 달라야 함 */
export function loadTestEvidence(path: string, expect: { run_id: string; digest: string }, schemaPath: string = DEFAULT_TEST_SCHEMA): TestEvidence {
  let validate;
  try {
    validate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  } catch {
    throw new SignerError("SCHEMA_UNAVAILABLE", `시험 결과 스키마를 불러오지 못해 증명서에 넣지 않음: ${schemaPath}`);
  }
  const data = readJson(path, "test_result");
  if (!validate(data)) {
    const first = validate.errors?.[0];
    throw new SignerError("TEST_RESULT_INVALID", `시험 결과가 TestResult 스키마와 맞지 않음 ${first?.instancePath || "(최상위)"}: ${first?.message ?? "알 수 없음"}`);
  }
  const t = parseWith(TestResultFieldsSchema, data, "test_result");
  if (t.run_id !== expect.run_id || t.digest !== expect.digest) {
    throw new SignerError("TEST_RESULT_MISMATCH", `시험 결과의 run_id·digest 가 서명할 plan 과 다름 (${t.run_id}, ${t.digest})`);
  }
  return TestEvidenceSchema.parse({
    sha256: sha256Hex(canonicalize(data)),
    passed: t.passed,
    match: { total: t.match.total, matched: t.match.matched },
    conditions: (t.facts?.conditions ?? []).map((c) => ({ name: c.name, total: c.total, matched: c.matched })),
  });
}

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
    test: TestEvidenceSchema.optional().describe("시험 결과를 줬을 때만"),
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
  test?: TestEvidence | undefined;
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
    ...(i.test !== undefined ? { test: i.test } : {}),
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
export function findDeployStatement(
  statements: readonly unknown[],
  result: SignResult,
  expectTestSha256?: string,
): { ok: true; predicate: DeployPredicate } | { ok: false; detail: string } {
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
    if (expectTestSha256 !== undefined && parsed.data.test?.sha256 !== expectTestSha256) {
      reason = parsed.data.test ? "증명서의 시험 결과 해시가 준 test_result 와 다름" : "증명서에 시험 결과가 없음";
      continue;
    }
    return { ok: true, predicate: parsed.data };
  }
  return { ok: false, detail: reason };
}
