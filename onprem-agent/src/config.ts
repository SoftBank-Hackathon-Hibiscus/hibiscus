import { resolve } from "node:path";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const environmentSchema = z.object({
  BACKEND_API_URL: z.string().url(),
  AGENT_ID: z.string().min(1),
  AGENT_TOKEN: z.string().min(32),
  COSIGN_PUBLIC_KEY: z.string().min(1),
  AGENT_STATE_FILE: z.string().min(1).default("./data/agent-state.json"),
  AGENT_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
  AGENT_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(10_000),
  BACKEND_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(10_000),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(100_000),
  DOCKER_STOP_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(10),
  DOCKER_COMMAND: z.string().min(1).default("docker"),
  COSIGN_COMMAND: z.string().min(1).default("cosign"),
  COSIGN_ALLOW_INSECURE_REGISTRY: booleanString.default(false),
  COSIGN_INSECURE_IGNORE_TLOG: booleanString.default(false),
  SSH_HOST: z.string().default(""),
  SSH_PORT: z.coerce.number().int().min(1).max(65_535).default(22),
  SSH_USER: z.string().default(""),
  SSH_IDENTITY_FILE: z.string().min(1).default("./data/ssh/agent_ed25519"),
  SSH_ENROLLMENT_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  SSH_HOST_KEY_SHA256: z
    .string()
    .refine(
      (value) => value === "" || /^SHA256:[A-Za-z0-9+/]{43}$/.test(value),
      "SSH host key fingerprint is invalid",
    )
    .default(""),
  SSH_READY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  SSH_FORWARD_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),
  SSH_SERVER_ALIVE_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(15),
  SSH_SERVER_ALIVE_COUNT_MAX: z.coerce.number().int().min(1).default(3),
  SSH_SESSION_MAX_MS: z.coerce.number().int().min(60_000).default(900_000),
});

export interface AgentConfig {
  apiUrl: URL;
  agentId: string;
  token: string;
  cosignPublicKey: string;
  stateFile: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  backendRequestTimeoutMs: number;
  commandTimeoutMs: number;
  dockerStopTimeoutSeconds: number;
  dockerCommand: string;
  cosignCommand: string;
  cosignAllowInsecureRegistry: boolean;
  cosignInsecureIgnoreTlog: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshIdentityFile: string;
  sshEnrollmentToken?: string;
  sshHostKeySha256: string;
  sshReadyTimeoutMs: number;
  sshForwardPollIntervalMs: number;
  sshServerAliveIntervalSeconds: number;
  sshServerAliveCountMax: number;
  sshSessionMaxMs: number;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const env = environmentSchema.parse(source);
  const apiUrl = new URL(env.BACKEND_API_URL);
  apiUrl.pathname = "/";
  apiUrl.search = "";
  apiUrl.hash = "";
  return {
    apiUrl,
    agentId: env.AGENT_ID,
    token: env.AGENT_TOKEN,
    cosignPublicKey: resolve(env.COSIGN_PUBLIC_KEY),
    stateFile: resolve(env.AGENT_STATE_FILE),
    pollIntervalMs: env.AGENT_POLL_INTERVAL_MS,
    heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    backendRequestTimeoutMs: env.BACKEND_REQUEST_TIMEOUT_MS,
    commandTimeoutMs: env.COMMAND_TIMEOUT_MS,
    dockerStopTimeoutSeconds: env.DOCKER_STOP_TIMEOUT_SECONDS,
    dockerCommand: env.DOCKER_COMMAND,
    cosignCommand: env.COSIGN_COMMAND,
    cosignAllowInsecureRegistry: env.COSIGN_ALLOW_INSECURE_REGISTRY,
    cosignInsecureIgnoreTlog: env.COSIGN_INSECURE_IGNORE_TLOG,
    sshHost: env.SSH_HOST,
    sshPort: env.SSH_PORT,
    sshUser: env.SSH_USER,
    sshIdentityFile: resolve(env.SSH_IDENTITY_FILE),
    sshEnrollmentToken: env.SSH_ENROLLMENT_TOKEN,
    sshHostKeySha256: env.SSH_HOST_KEY_SHA256,
    sshReadyTimeoutMs: env.SSH_READY_TIMEOUT_MS,
    sshForwardPollIntervalMs: env.SSH_FORWARD_POLL_INTERVAL_MS,
    sshServerAliveIntervalSeconds: env.SSH_SERVER_ALIVE_INTERVAL_SECONDS,
    sshServerAliveCountMax: env.SSH_SERVER_ALIVE_COUNT_MAX,
    sshSessionMaxMs: env.SSH_SESSION_MAX_MS,
  };
}
