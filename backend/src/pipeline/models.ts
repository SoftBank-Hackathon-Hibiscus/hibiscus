/**
 * 백엔드가 기록하는 모델과 API 입력 형식.
 * run_id, digest, source_revision, 사람 id 규칙은 contracts/ 의 공통 값 규칙과 같다.
 */
import { z } from "zod";

export const RunIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "run_id 는 영문·숫자·._- 만, 1~64자");
export const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "digest 는 'sha256:' 뒤에 소문자 hex 64자");
export const SourceRevisionSchema = z.string().regex(/^[0-9a-f]{7,40}$/, "source_revision 은 소문자 hex 7~40자");
export const PersonSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "사람 id 는 영문·숫자·._- 만, 1~64자");
/** 태그·digest 없는 이미지 저장소 주소 (signer 와 같은 규칙) */
export const ImageRepoSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/, "이미지 저장소는 태그·digest 없이 <호스트>/<경로>");

export const TEST_TEMPLATES = ["allow", "block-test-failed"] as const;
export type TestTemplate = (typeof TEST_TEMPLATES)[number];

export const STAGES = ["test", "policy", "sign", "deploy"] as const;
export type StageName = (typeof STAGES)[number];

export const RUN_STATUSES = ["queued", "running", "awaiting_approval", "blocked", "failed", "succeeded"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type Decision = "allow" | "needs_approval" | "block";
export type DigestSource = "registry" | "placeholder";
export type ExecutionMode = "skeleton";

export interface DeploymentApp {
  id: string;
  name: string;
  /** 앱 소스 폴더 (절대 경로). 정책 단계의 --src */
  src_path: string;
  /** 태그 없는 이미지 저장소. 서명·배포가 digest 와 합쳐 쓴다 */
  image_repo: string;
  /** GitHub 저장소 owner/name. webhook 연결(다음 PR) 전까지는 기록만 */
  repo?: string;
  default_branch?: string;
  /** policy/ 기준 정책 파일 경로. 기본 policy.yaml */
  policy_path?: string;
  /** 테스트 stub 이 쓸 test_result 템플릿 */
  test_template: TestTemplate;
  created_at: string;
}

export interface DeploymentRun {
  run_id: string;
  app_id: string;
  trigger: "manual";
  /** 커밋 SHA. 앱 소스가 git 저장소면 HEAD 로 확정한 값 */
  source_revision: string;
  /** HEAD 와 대조해 확정했고 작업 트리에 커밋 안 된 변경이 없을 때만 true */
  source_revision_verified: boolean;
  digest: string;
  digest_source: DigestSource;
  /** 정책 결정. 정책 단계가 끝나면 채워진다 */
  decision?: Decision;
  status: RunStatus;
  current_stage: StageName | null;
  /** 실행을 요청한 사람 id. 인증은 아직 하지 않는다 (README 참고) */
  requester: string;
  /** WORK_DIR 기준 상대 경로 */
  work_dir: string;
  execution_mode: ExecutionMode;
  deployment_performed: boolean;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface StageExecution {
  id: string;
  run_id: string;
  stage: StageName;
  attempt: number;
  status: StageStatus;
  exit_code?: number | null;
  started_at: string;
  finished_at?: string;
  /** 산출물 이름 → WORK_DIR 기준 상대 경로 */
  artifacts: Record<string, string>;
  summary?: unknown;
  error?: string;
}

export const CreateAppInputSchema = z.strictObject({
  name: z.string().min(1).max(64),
  src_path: z.string().min(1),
  image_repo: ImageRepoSchema,
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo 는 owner/name").optional(),
  default_branch: z.string().min(1).optional(),
  policy_path: z.string().min(1).optional(),
  test_template: z.enum(TEST_TEMPLATES).default("allow"),
});
export type CreateAppInput = z.infer<typeof CreateAppInputSchema>;

export const CreateRunInputSchema = z.strictObject({
  requester: PersonSchema,
  source_revision: SourceRevisionSchema.optional(),
  digest: DigestSchema.optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

export const ApproveInputSchema = z.strictObject({
  approver: PersonSchema,
});
export type ApproveInput = z.infer<typeof ApproveInputSchema>;
