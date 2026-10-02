import type { AgentConfig } from "./config.js";
import type {
  AgentJob,
  AgentJobResult,
  BackendAgentClient,
  ServingContainer,
  SshForward,
  SshEnrollment,
} from "./types.js";
import { FatalAgentError } from "./types.js";

export class BackendClient implements BackendAgentClient {
  constructor(private readonly config: AgentConfig) {}

  async nextJob(): Promise<AgentJob | undefined> {
    const response = await this.request("agent/v1/jobs/next", {
      method: "GET",
    });
    if (response.status === 204) return undefined;
    return (await response.json()) as AgentJob;
  }

  async submitResult(result: AgentJobResult): Promise<void> {
    const response = await this.request(
      `agent/v1/jobs/${encodeURIComponent(result.job_id)}/result`,
      {
        method: "POST",
        body: JSON.stringify(result),
      },
    );
    await response.body?.cancel();
  }

  async heartbeat(serving: ServingContainer | null): Promise<void> {
    const response = await this.request("agent/v1/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        schema_version: 1,
        agent_id: this.config.agentId,
        updated_at: new Date().toISOString(),
        serving,
      }),
    });
    await response.body?.cancel();
  }

  async forwards(): Promise<SshForward[]> {
    const response = await this.request("agent/v1/forwards", { method: "GET" });
    return (await response.json()) as SshForward[];
  }

  async enrollSsh(token: string, publicKey: string): Promise<SshEnrollment> {
    const response = await this.requestWithToken(
      "agent/v1/ssh/enroll",
      token,
      {
        method: "POST",
        body: JSON.stringify({ public_key: publicKey }),
      },
      "SSH enrollment token was rejected by Backend",
    );
    return (await response.json()) as SshEnrollment;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    return this.requestWithToken(path, this.config.token, init);
  }

  private async requestWithToken(
    path: string,
    token: string,
    init: RequestInit,
    rejectedMessage = "Agent token was rejected by Backend",
  ): Promise<Response> {
    const response = await fetch(new URL(path, this.config.apiUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.config.backendRequestTimeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new FatalAgentError(rejectedMessage);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 512);
      throw new Error(
        `Backend request failed with ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return response;
  }
}
