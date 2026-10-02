import { resolve } from "node:path";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const environmentSchema = z.object({
  BACKEND_TUNNEL_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith("ws://") || value.startsWith("wss://"),
      { message: "BACKEND_TUNNEL_URL must use ws or wss" },
    ),
  BACKEND_API_URL: z.string().url().optional(),
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
  TUNNEL_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(1_000),
  TUNNEL_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(30_000),
  TUNNEL_HANDSHAKE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(10_000),
  TUNNEL_LOCAL_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(3_000),
});

export interface AgentConfig {
  apiUrl: URL;
  controlUrl: URL;
  dataUrl: URL;
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
  reconnectMinMs: number;
  reconnectMaxMs: number;
  handshakeTimeoutMs: number;
  localConnectTimeoutMs: number;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const env = environmentSchema.parse(source);
  const controlUrl = new URL(env.BACKEND_TUNNEL_URL);
  controlUrl.pathname = "/agent/v1/tunnel/control";
  controlUrl.search = "";
  controlUrl.hash = "";
  const dataUrl = new URL(controlUrl);
  dataUrl.pathname = "/agent/v1/tunnel/data";
  const apiUrl = env.BACKEND_API_URL
    ? new URL(env.BACKEND_API_URL)
    : new URL(controlUrl);
  if (!env.BACKEND_API_URL) {
    apiUrl.protocol = controlUrl.protocol === "wss:" ? "https:" : "http:";
  }
  apiUrl.pathname = "/";
  apiUrl.search = "";
  apiUrl.hash = "";
  return {
    apiUrl,
    controlUrl,
    dataUrl,
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
    reconnectMinMs: env.TUNNEL_RECONNECT_MIN_MS,
    reconnectMaxMs: env.TUNNEL_RECONNECT_MAX_MS,
    handshakeTimeoutMs: env.TUNNEL_HANDSHAKE_TIMEOUT_MS,
    localConnectTimeoutMs: env.TUNNEL_LOCAL_CONNECT_TIMEOUT_MS,
  };
}
