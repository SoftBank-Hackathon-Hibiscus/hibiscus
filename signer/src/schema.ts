// signer 가 읽고 쓰는 형식. run_id·digest·plan_hash 규칙은 policy 와 같음
import { z } from "zod";

export const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "digest 는 'sha256:' 뒤에 소문자 hex 64자여야 합니다")
  .describe("컨테이너 이미지 지문. 'sha256:' + 소문자 hex 64자 (plan.digest 그대로)");
export const RunIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "run_id 는 영문·숫자·._- 만, 1~64자여야 합니다")
  .describe("파이프라인 실행 id (plan.run_id 그대로)");
export const PlanHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "plan_hash 는 소문자 hex 64자여야 합니다 (접두어 없음)")
  .describe("plan.plan_hash 그대로. 접두어 없이 소문자 hex 64자");
export const SourceRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "source_revision 은 소문자 hex 7~40자여야 합니다")
  .describe("커밋 SHA. plan 에 있을 때만");
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const PersonSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "사람 id 는 영문·숫자·._- 만, 1~64자여야 합니다")
  .describe("GitHub 아이디 등 사람 id");
export const AUTO_APPROVER = "auto";
/** 같은 사람인지. GitHub 아이디는 대소문자를 구분하지 않아서 alice 와 Alice 를 같은 사람으로 봄 */
export const samePerson = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const TimeSchema = z.string().describe("ISO 8601 시각");

export const DecisionSchema = z.enum(["allow", "block", "needs_approval"]);

/** 서명에 쓰는 필드만. 전체 검사는 Plan.schema.json */
export const PlanSchema = z.looseObject({
  run_id: RunIdSchema,
  digest: DigestSchema,
  source_revision: SourceRevisionSchema.optional(),
  decision: DecisionSchema,
  targets: z.array(z.string()),
  failover_allowed: z.boolean(),
  plan_hash: PlanHashSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

export const ApprovalSchema = z
  .strictObject({
    run_id: RunIdSchema,
    digest: DigestSchema,
    plan_hash: PlanHashSchema,
    plan_sha256: Sha256HexSchema.describe("승인할 때 본 plan.json 전체(키 정렬 JSON)의 sha256. 승인 뒤 targets 등이 바뀌면 달라짐"),
    requester: PersonSchema.describe("배포를 요청한 사람"),
    approver: PersonSchema.refine((v) => !samePerson(v, AUTO_APPROVER), "approver 에 auto 는 쓸 수 없습니다 (대소문자 무관)").describe("승인한 사람. requester 와 달라야 함"),
    approved_at: TimeSchema,
  })
  .describe("needs_approval plan 에 대한 사람 승인 기록");
export type Approval = z.infer<typeof ApprovalSchema>;

export const SignResultSchema = z
  .strictObject({
    run_id: RunIdSchema,
    digest: DigestSchema,
    source_revision: SourceRevisionSchema.optional(),
    plan_hash: PlanHashSchema,
    targets: z.array(z.string()).min(1).describe("plan.targets 그대로. 배포 쪽은 다시 판단하지 않음"),
    failover_allowed: z.boolean().describe("plan.failover_allowed 그대로"),
    requester: PersonSchema,
    approver: PersonSchema.describe("승인한 사람. allow 면 auto"),
    signature_ref: z
      .string()
      .min(1)
      .describe("서명 위치. cosign 로컬 키면 'cosign:<저장소>@<digest>' (서명은 그 이미지에 붙음). 시험 실행이면 'dry-run:...'"),
    signed_at: TimeSchema,
  })
  .describe("서명 결과. 배포 파트가 읽음");
export type SignResult = z.infer<typeof SignResultSchema>;

export const RefuseReasonSchema = z.enum([
  "policy_block",
  "no_targets",
  "approval_missing",
  "approval_mismatch",
  "requester_mismatch",
  "self_approval",
  "approval_expired",
  "sign_failed",
]);
export type RefuseReason = z.infer<typeof RefuseReasonSchema>;

export const SignLogSchema = z
  .strictObject({
    kind: z.literal("sign").describe("서명 결정"),
    time: TimeSchema,
    run_id: RunIdSchema,
    digest: DigestSchema,
    source_revision: SourceRevisionSchema.optional(),
    plan_hash: PlanHashSchema,
    result: z.enum(["signed", "refused"]),
    requester: PersonSchema,
    approver: PersonSchema.nullable().describe("서명했거나 승인 기록이 있으면 그 사람, 없으면 null"),
    reason: RefuseReasonSchema.nullable().describe("refused 일 때 이유, signed 면 null"),
    signature_ref: z.string().nullable().describe("signed 일 때 sign_result.signature_ref, refused 면 null"),
  })
  .describe("decisions.jsonl 의 kind: sign 한 줄");
export type SignLog = z.infer<typeof SignLogSchema>;

export const SignErrorSchema = z
  .strictObject({
    kind: z.literal("sign_error").describe("결정 전에 난 서명 실패"),
    time: TimeSchema,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).describe("SignerError 코드 (PLAN_INVALID, REQUESTER_INVALID 등)"),
    message: z.string().max(500),
    run_id: RunIdSchema.optional().describe("plan 을 읽은 뒤에 난 오류면 그 실행 id"),
    requester: z.string().max(100).optional().describe("요청자로 들어온 값 그대로 (형식이 틀렸을 수 있음)"),
  })
  .describe("plan·승인 기록 형식 오류처럼 서명 결정 전에 멈춘 시도. 감사 로그에만 남김 (decisions.jsonl 계약은 그대로)");
export type SignError = z.infer<typeof SignErrorSchema>;

export const RevokeReasonSchema = z.enum(["vulnerability", "policy_changed", "key_compromise", "mistake"]);

export const RevokeSchema = z
  .strictObject({
    kind: z.literal("revoke").describe("서명 철회"),
    time: TimeSchema,
    digest: DigestSchema,
    run_id: RunIdSchema.optional().describe("있으면 그 실행의 서명만, 없으면 이 이미지의 서명 전부 (이후 서명도 거부)"),
    reason: RevokeReasonSchema,
    by: PersonSchema.describe("철회한 사람"),
    note: z.string().max(200).optional(),
  })
  .describe("이미 한 서명을 더는 배포에 쓰지 않게 막는 기록. 감사 로그에만 남김 (decisions.jsonl 계약은 그대로)");
export type Revoke = z.infer<typeof RevokeSchema>;

export const ObservedSchema = z
  .strictObject({
    kind: z.literal("observed"),
    target: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).describe("배포 위치 (onprem, cloud_run 등)"),
    image: z.string().regex(/^[^@\s]+@sha256:[0-9a-f]{64}$/).describe("실제로 떠 있는 이미지 <저장소>@sha256:<hex>"),
    observed_at: TimeSchema,
    source: z.string().max(200).describe("어디서 봤는지 (gcloud run revisions describe, docker inspect 등)"),
  })
  .describe("실제 배포 상태 관측 한 줄. 운영자가 아닌 사람(감사자)이 만들어야 의미 있음. signer reconcile 입력");
export type Observed = z.infer<typeof ObservedSchema>;

// cosign -a 값으로 쓸 수 있는 문자. cosign 은 쉼표로 값을 나누고 = 가 두 번이면 거절해서, encodeURIComponent 결과와 구분자 + 만 허용
export const ANNOTATION_VALUE_RE = /^[A-Za-z0-9._~%!'()*+-]*$/;
export const ANNOTATION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const AuditLineSchema = z
  .strictObject({
    seq: z.int().min(1).describe("줄 번호. 1 부터 빈 번호 없이"),
    prev_hash: Sha256HexSchema.describe("앞 줄 hash. 첫 줄은 0 이 64개"),
    entry: z.discriminatedUnion("kind", [SignLogSchema, SignErrorSchema, RevokeSchema]),
    anchor: Sha256HexSchema.optional().describe("signed 줄에만. 서명 직전 체인 끝 hash (이미지 서명 주석 audit_head 와 같은 값)"),
    annotations: z
      .record(z.string().regex(ANNOTATION_KEY_RE), z.string().regex(ANNOTATION_VALUE_RE))
      .optional()
      .describe("signed 줄에만. 이미지 서명에 실제로 붙인 주석 전체. 주석만 바꾼 쌍둥이 서명과 구분하는 데 씀"),
    cancels: Sha256HexSchema.optional().describe("서명 뒤 단계(자기 확인·증명서)가 실패한 refused 줄에만. 취소하는 signed 줄의 hash"),
    hash: Sha256HexSchema.describe("이 줄 hash. sha256(키 정렬 JSON {seq, prev_hash, entry, anchor, annotations, cancels})"),
  })
  .describe("서명 감사 로그(해시 체인) 한 줄. signer 안에서만 씀");
export type AuditLine = z.infer<typeof AuditLineSchema>;
export type AuditEntry = AuditLine["entry"];
