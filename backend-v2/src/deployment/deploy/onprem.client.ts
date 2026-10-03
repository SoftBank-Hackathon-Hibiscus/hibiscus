import { NotFoundException } from '@nestjs/common';
import type { AgentJobService } from '../../agent/agent-job.service.js';
import type { CreateAgentJobDto } from '../../agent/dto/agent-job.dto.js';
import type {
  OnpremJobOutcome,
  OnpremJobSpec,
  OnpremPort,
} from '../types/deploy-result.type.js';

export interface OnpremOptions {
  candidateTimeoutMs: number;
  actionTimeoutMs: number;
  pollMs: number;
}

type JobView = ReturnType<AgentJobService['get']>;
type Sleep = (ms: number) => Promise<void>;

/**
 * 온프레 Agent 작업을 backend 작업 API(태현님 AgentJobService)로 만들고 결과를 기다린다.
 * job_id 는 `<run_id>-<action>-01` 로 고정한다. 서버가 재시작돼 배포 단계가 다시 돌면
 * 새로 만들지 않고 같은 작업의 결과를 이어서 기다린다.
 */
export class OnpremClient implements OnpremPort {
  constructor(
    private readonly jobs: AgentJobService,
    private readonly options: OnpremOptions,
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async run(spec: OnpremJobSpec): Promise<OnpremJobOutcome> {
    const jobId = `${spec.runId}-${spec.action}-01`;
    let view = this.find(spec.agentId, jobId);
    if (!view) {
      const timeout =
        spec.action === 'candidate'
          ? this.options.candidateTimeoutMs
          : this.options.actionTimeoutMs;
      const input = {
        schema_version: 1,
        job_id: jobId,
        run_id: spec.runId,
        action: spec.action,
        digest: spec.digest,
        ...(spec.image ? { image: spec.image } : {}),
        ...(spec.planHash ? { plan_hash: spec.planHash } : {}),
        ...(spec.toDigest ? { to_digest: spec.toDigest } : {}),
        ...(spec.environment ? { environment: spec.environment } : {}),
        deadline: new Date(Date.now() + timeout).toISOString(),
      } as CreateAgentJobDto;
      this.jobs.create(spec.agentId, input);
      view = this.find(spec.agentId, jobId)!;
    }

    // deadline 이 지나면 서버가 expired 로 바꾼다. 결과 제출이 늦게 도착할 여유를 조금 둔다
    const giveUpAt = Date.parse(view.job.deadline) + this.options.pollMs * 2;
    for (;;) {
      if (view.status === 'succeeded' || view.status === 'failed')
        return this.outcome(jobId, view);
      if (view.status === 'expired')
        return {
          jobId,
          status: 'expired',
          error: 'Agent did not finish before the job deadline',
        };
      if (Date.now() > giveUpAt)
        return {
          jobId,
          status: 'timeout',
          error: 'Timed out waiting for the agent result',
        };
      await this.sleep(this.options.pollMs);
      view = this.find(spec.agentId, jobId)!;
    }
  }

  private outcome(jobId: string, view: JobView): OnpremJobOutcome {
    const payload = view.results.at(-1)?.payload;
    if (view.status === 'succeeded' && payload?.result === 'ok')
      return { jobId, status: 'succeeded', payload };
    return {
      jobId,
      status: 'failed',
      payload,
      error: payload?.error ?? 'Agent reported a failure',
    };
  }

  private find(agentId: string, jobId: string): JobView | undefined {
    try {
      return this.jobs.get(agentId, jobId);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }
}
