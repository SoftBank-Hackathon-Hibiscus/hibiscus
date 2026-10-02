import { registerAs } from '@nestjs/config';
import { z } from 'zod';

// 배포 단계(DEPLOY_MODE=real) 전용 설정. 비어 있는 경로는 REPO_ROOT 기준 기본값을 쓴다.
export const deployEnvironmentSchema = z.object({
  GCP_PROJECT_ID: z.string().trim().default(''),
  GCP_REGION: z.string().trim().min(1).default('asia-northeast3'),
  // 비우면 Application slug를 Cloud Run 서비스 이름으로 쓴다
  CLOUD_RUN_SERVICE: z.string().trim().default(''),
  CLOUD_RUN_TAG: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,45}$/)
    .default('cand'),
  CLOUD_RUN_SCRIPTS_DIR: z.string().trim().default(''),
  COSIGN_COMMAND: z.string().trim().min(1).default('cosign'),
  COSIGN_PUBLIC_KEY: z.string().trim().default(''),
  // Rekor 없이 서명한 이미지(signer --no-tlog)를 확인할 때만 true. 비우면 SIGNER_NO_TLOG=1 을 따른다
  COSIGN_IGNORE_TLOG: z.enum(['true', 'false']).optional(),
  SIGNER_NO_TLOG: z.string().trim().default(''),
  DEPLOY_SCRIPT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  DEPLOY_CANDIDATE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(120_000),
  DEPLOY_ACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  DEPLOY_JOB_POLL_MS: z.coerce.number().int().min(20).default(2_000),
});

export const deployConfig = registerAs('deploy', () => {
  const env = deployEnvironmentSchema.parse({
    ...process.env,
    GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || process.env.PROJECT_ID,
    GCP_REGION: process.env.GCP_REGION || process.env.REGION || undefined,
  });
  return {
    projectId: env.GCP_PROJECT_ID,
    region: env.GCP_REGION,
    cloudRunService: env.CLOUD_RUN_SERVICE,
    cloudRunTag: env.CLOUD_RUN_TAG,
    cloudRunScriptsDir: env.CLOUD_RUN_SCRIPTS_DIR,
    cosignCommand: env.COSIGN_COMMAND,
    cosignPublicKey: env.COSIGN_PUBLIC_KEY,
    cosignIgnoreTlog: env.COSIGN_IGNORE_TLOG
      ? env.COSIGN_IGNORE_TLOG === 'true'
      : env.SIGNER_NO_TLOG === '1',
    scriptTimeoutMs: env.DEPLOY_SCRIPT_TIMEOUT_MS,
    candidateTimeoutMs: env.DEPLOY_CANDIDATE_TIMEOUT_MS,
    actionTimeoutMs: env.DEPLOY_ACTION_TIMEOUT_MS,
    jobPollMs: env.DEPLOY_JOB_POLL_MS,
  };
});
export type DeployConfig = { deploy: ReturnType<typeof deployConfig> };
