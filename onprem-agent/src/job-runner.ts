import type { AgentConfig } from "./config.js";
import type { JobExecutor } from "./job-executor.js";
import type { BackendAgentClient } from "./types.js";
import { FatalAgentError } from "./types.js";

export class JobRunner {
  private stopping = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly backend: BackendAgentClient,
    private readonly executor: JobExecutor,
  ) {}

  async start(): Promise<void> {
    await this.executor.restore();
    await Promise.all([this.pollLoop(), this.heartbeatLoop()]);
  }

  stop(): void {
    this.stopping = true;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const job = await this.backend.nextJob();
        if (job) {
          if (job.agent_id !== this.config.agentId) {
            throw new FatalAgentError(
              "Job agent_id does not match the configured Agent",
            );
          }
          const result = await this.executor.execute(job);
          await this.backend.submitResult(result);
        }
      } catch (error) {
        if (error instanceof FatalAgentError) throw error;
        console.error(`[agent-job] ${this.message(error)}`);
      }
      await this.wait(this.config.pollIntervalMs);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.backend.heartbeat(await this.executor.serving());
      } catch (error) {
        if (error instanceof FatalAgentError) throw error;
        console.error(`[agent-heartbeat] ${this.message(error)}`);
      }
      await this.wait(this.config.heartbeatIntervalMs);
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }

  private wait(delay: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
