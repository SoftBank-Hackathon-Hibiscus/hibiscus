import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const environmentSchema = z.object({
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
  POLICY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  SIGNER_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  AGENT_OFFLINE_AFTER_MS: z.coerce.number().int().min(1_000).default(30_000),
  AGENT_CANDIDATE_LEASE_MS: z.coerce.number().int().min(1_000).default(120_000),
  AGENT_ACTION_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
  TUNNEL_PING_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  TUNNEL_HEARTBEAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(2_000)
    .default(30_000),
  TUNNEL_OPEN_TIMEOUT_MS: z.coerce.number().int().min(500).default(5_000),
  TUNNEL_MAX_CHANNELS_PER_AGENT: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(100),
  TUNNEL_MAX_FRAME_BYTES: z.coerce
    .number()
    .int()
    .min(16_384)
    .default(1_048_576),
  GATEWAY_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  HEALTH_MONITOR_ENABLED: booleanString.default(true),
  HEALTH_MONITOR_TICK_MS: z.coerce.number().int().min(250).default(1_000),
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
    policyTimeoutMs: env.POLICY_TIMEOUT_MS,
    signerTimeoutMs: env.SIGNER_TIMEOUT_MS,
    agentOfflineAfterMs: env.AGENT_OFFLINE_AFTER_MS,
    agentCandidateLeaseMs: env.AGENT_CANDIDATE_LEASE_MS,
    agentActionLeaseMs: env.AGENT_ACTION_LEASE_MS,
    tunnelPingIntervalMs: env.TUNNEL_PING_INTERVAL_MS,
    tunnelHeartbeatTimeoutMs: env.TUNNEL_HEARTBEAT_TIMEOUT_MS,
    tunnelOpenTimeoutMs: env.TUNNEL_OPEN_TIMEOUT_MS,
    tunnelMaxChannelsPerAgent: env.TUNNEL_MAX_CHANNELS_PER_AGENT,
    tunnelMaxFrameBytes: env.TUNNEL_MAX_FRAME_BYTES,
    gatewayIdleTimeoutMs: env.GATEWAY_IDLE_TIMEOUT_MS,
    healthMonitorEnabled: env.HEALTH_MONITOR_ENABLED,
    healthMonitorTickMs: env.HEALTH_MONITOR_TICK_MS,
    npmCommand:
      process.env.NPM_COMMAND ||
      (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
  };
});
export type BackendConfig = { backend: ReturnType<typeof backendConfig> };
