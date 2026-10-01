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
    approver: PersonSchema.refine((v) => v !== AUTO_APPROVER, "approver 에 auto 는 쓸 수 없습니다").describe("승인한 사람. requester 와 달라야 함"),
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
