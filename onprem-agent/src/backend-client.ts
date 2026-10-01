import type { AgentConfig } from "./config.js";
import type {
  AgentJob,
  AgentJobResult,
  BackendAgentClient,
  ServingContainer,
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

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(new URL(path, this.config.apiUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.config.backendRequestTimeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new FatalAgentError("Agent token was rejected by Backend");
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
