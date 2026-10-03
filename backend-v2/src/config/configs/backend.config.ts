import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const environmentSchema = z
  .object({
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    DATABASE_FILE: z
      .string()
      .min(1)
      .default('./data/backend.db')
      .transform((value) => resolve(value)),
    WORKER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
    REPO_ROOT: z
      .string()
      .min(1)
      .default('..')
      .transform((value) => resolve(value)),
    CLI_TEMP_DIR: z
      .string()
      .min(1)
      .default(join(tmpdir(), 'hibiscus-cli'))
      .transform((value) => resolve(value)),
    STAGE_MODE: z.enum(['skeleton', 'cli']).default('skeleton'),
    SIGNER_MODE: z.enum(['dry', 'real']).default('dry'),
    DEPLOY_MODE: z.enum(['off', 'dry', 'real']).default('off'),
    PARITY_TEST_MODE: z.enum(['fixture', 'registry']).default('fixture'),
    PARITY_INPUTS_FILE: z.string().default(''),
    PARITY_PYTHON_COMMAND: z.string().min(1).default('python3'),
    PARITY_BUILDER: z.string().default(''),
    PARITY_PLATFORMS: z
      .enum(['linux/amd64', 'linux/arm64', 'linux/amd64,linux/arm64'])
      .default('linux/amd64,linux/arm64'),
    PARITY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(1_200_000),
    GITHUB_CHECKOUT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(120_000),
    POLICY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
    SIGNER_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
    AGENT_OFFLINE_AFTER_MS: z.coerce.number().int().min(1_000).default(30_000),
    AGENT_CANDIDATE_LEASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(120_000),
    AGENT_ACTION_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
    GATEWAY_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
    GATEWAY_BASE_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
        'GATEWAY_BASE_DOMAIN must be a valid hostname',
      )
      .default('lth.so'),
    HEALTH_MONITOR_ENABLED: booleanString.default(true),
    HEALTH_MONITOR_TICK_MS: z.coerce.number().int().min(250).default(1_000),
    SSH_FORWARD_PORT_MIN: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(65_535)
      .default(20_000),
    SSH_FORWARD_PORT_MAX: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(65_535)
      .default(29_999),
    SSH_FORWARD_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .default(3_000),
    SSH_SERVER_ENABLED: booleanString.default(true),
    SSH_BIND_HOST: z.string().min(1).default('0.0.0.0'),
    SSH_HOST: z.string().min(1),
    SSH_PORT: z.coerce.number().int().min(0).max(65_535).default(2_222),
    SSH_USER: z.string().min(1).default('hibiscus-agent'),
    SSH_HOST_KEY_FILE: z
      .string()
      .min(1)
      .default('./data/ssh/host_ed25519')
      .transform((value) => resolve(value)),
    SSH_ENROLLMENT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(600),
  })
  .refine((value) => value.SSH_FORWARD_PORT_MIN <= value.SSH_FORWARD_PORT_MAX, {
    message: 'SSH_FORWARD_PORT_MIN must not exceed SSH_FORWARD_PORT_MAX',
  });

export const backendConfig = registerAs('backend', () => {
  const env = environmentSchema.parse({
    ...process.env,
    CLI_TEMP_DIR: process.env.CLI_TEMP_DIR || undefined,
  });
  return {
    host: env.HOST,
    port: env.PORT,
    databaseFile: env.DATABASE_FILE,
    workerPollMs: env.WORKER_POLL_MS,
    repoRoot: env.REPO_ROOT,
    cliTempDir: env.CLI_TEMP_DIR,
    stageMode: env.STAGE_MODE,
    signerMode: env.SIGNER_MODE,
    deployMode: env.DEPLOY_MODE,
    parityTestMode: env.PARITY_TEST_MODE,
    parityInputsFile: env.PARITY_INPUTS_FILE,
    parityPythonCommand: env.PARITY_PYTHON_COMMAND,
    parityBuilder: env.PARITY_BUILDER,
    parityPlatforms: env.PARITY_PLATFORMS,
    parityTimeoutMs: env.PARITY_TIMEOUT_MS,
    githubCheckoutTimeoutMs: env.GITHUB_CHECKOUT_TIMEOUT_MS,
    policyTimeoutMs: env.POLICY_TIMEOUT_MS,
    signerTimeoutMs: env.SIGNER_TIMEOUT_MS,
    agentOfflineAfterMs: env.AGENT_OFFLINE_AFTER_MS,
    agentCandidateLeaseMs: env.AGENT_CANDIDATE_LEASE_MS,
    agentActionLeaseMs: env.AGENT_ACTION_LEASE_MS,
    gatewayIdleTimeoutMs: env.GATEWAY_IDLE_TIMEOUT_MS,
    gatewayBaseDomain: env.GATEWAY_BASE_DOMAIN,
    healthMonitorEnabled: env.HEALTH_MONITOR_ENABLED,
    healthMonitorTickMs: env.HEALTH_MONITOR_TICK_MS,
    sshForwardPortMin: env.SSH_FORWARD_PORT_MIN,
    sshForwardPortMax: env.SSH_FORWARD_PORT_MAX,
    sshForwardConnectTimeoutMs: env.SSH_FORWARD_CONNECT_TIMEOUT_MS,
    sshServerEnabled: env.SSH_SERVER_ENABLED,
    sshBindHost: env.SSH_BIND_HOST,
    sshHost: env.SSH_HOST,
    sshPort: env.SSH_PORT,
    sshUser: env.SSH_USER,
    sshHostKeyFile: env.SSH_HOST_KEY_FILE,
    sshEnrollmentTtlSeconds: env.SSH_ENROLLMENT_TTL_SECONDS,
    npmCommand:
      process.env.NPM_COMMAND ||
      (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
  };
});
export type BackendConfig = { backend: ReturnType<typeof backendConfig> };
