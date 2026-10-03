import type { StateStore } from "./state-store.js";
import type {
  AgentJob,
  AgentJobResult,
  AgentState,
  CachedJobResult,
  ContainerRuntime,
  HealthProbe,
  ManagedContainer,
  ServingContainer,
  SignatureVerifier,
} from "./types.js";

export class JobExecutor {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly agentId: string,
    private readonly stateStore: StateStore,
    private readonly runtime: ContainerRuntime,
    private readonly verifier: SignatureVerifier,
    private readonly health: HealthProbe,
  ) {}

  async restore(): Promise<void> {
    await this.serialized(() => this.reconcile());
  }

  async serving(): Promise<ServingContainer | null> {
    return this.serialized(async () => {
      await this.reconcile();
      const state = await this.stateStore.read();
      const container = state.serving_container
        ? state.containers[state.serving_container]
        : undefined;
      return container ? this.servingView(container) : null;
    });
  }

  async execute(job: AgentJob): Promise<AgentJobResult> {
    return this.serialized(() => this.executeJob(job));
  }

  private async reconcile(): Promise<void> {
    const state = await this.stateStore.read();
    const containers = await this.runtime.reconcile(
      Object.values(state.containers),
      state.serving_container,
    );
    state.containers = Object.fromEntries(
      containers.map((container) => [container.container, container]),
    );
    if (state.serving_container && !state.containers[state.serving_container]) {
      state.serving_container = null;
    }
    await this.stateStore.write(state);
  }

  private async executeJob(job: AgentJob): Promise<AgentJobResult> {
    const state = await this.stateStore.read();
    const cached = state.completed_jobs[job.job_id];
    if (cached) return { ...cached, attempt: job.attempt };

    let result: AgentJobResult;
    try {
      result = await this.executeAction(job, state);
    } catch (error) {
      result = this.failed(job, error);
    }
    const { attempt: _attempt, ...cache } = result;
    state.completed_jobs[job.job_id] = cache as CachedJobResult;
    await this.stateStore.write(state);
    return result;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async executeAction(
    job: AgentJob,
    state: AgentState,
  ): Promise<AgentJobResult> {
    if (Date.now() >= Date.parse(job.deadline)) {
      throw new Error("Job deadline has passed");
    }
    if (job.action === "candidate") return this.candidate(job, state);
    if (job.action === "activate") return this.activate(job, state);
    if (job.action === "rollback") return this.rollback(job, state);
    return this.discard(job, state);
  }

  private async candidate(
    job: AgentJob,
    state: AgentState,
  ): Promise<AgentJobResult> {
    await this.verifier.verify(job);
    const existing = this.find(state, job.digest, job.run_id);
    const candidate = await this.runtime.createCandidate(job, existing);
    const check = await this.health.check(job, candidate);
    if (!check.pass) {
      await this.runtime.remove(candidate);
      delete state.containers[candidate.container];
      throw new Error("Candidate health check failed");
    }
    candidate.role = "candidate";
    state.containers[candidate.container] = candidate;
    return {
      ...this.base(job),
      result: "ok",
      candidate: {
        digest: candidate.digest,
        container: candidate.container,
        url: candidate.url,
      },
      check,
      finished_at: new Date().toISOString(),
    };
  }

  private async activate(
    job: AgentJob,
    state: AgentState,
  ): Promise<AgentJobResult> {
    const target = this.requiredContainer(state, job.digest, job.run_id);
    const previous = this.current(state);
    await this.runtime.activate(target, previous);
    if (previous && previous.container !== target.container) {
      previous.role = "standby";
    }
    target.role = "serving";
    state.serving_container = target.container;
    return {
      ...this.base(job),
      result: "ok",
      ...(previous ? { previous: this.servingView(previous) } : {}),
      serving: this.servingView(target),
      finished_at: new Date().toISOString(),
    };
  }

  private async rollback(
    job: AgentJob,
    state: AgentState,
  ): Promise<AgentJobResult> {
    if (!job.to_digest) throw new Error("Rollback job is missing to_digest");
    const target = this.requiredContainer(state, job.to_digest);
    const previous = this.current(state);
    await this.runtime.activate(target, previous);
    if (previous && previous.container !== target.container) {
      previous.role = "standby";
    }
    target.role = "serving";
    state.serving_container = target.container;
    return {
      ...this.base(job),
      result: "ok",
      ...(previous ? { previous: this.servingView(previous) } : {}),
      serving: this.servingView(target),
      finished_at: new Date().toISOString(),
    };
  }

  private async discard(
    job: AgentJob,
    state: AgentState,
  ): Promise<AgentJobResult> {
    const target = this.find(state, job.digest, job.run_id);
    if (target) {
      if (state.serving_container === target.container) {
        throw new Error("Serving container cannot be discarded");
      }
      await this.runtime.remove(target);
      delete state.containers[target.container];
    }
    return {
      ...this.base(job),
      result: "ok",
      finished_at: new Date().toISOString(),
    };
  }

  private current(state: AgentState): ManagedContainer | undefined {
    return state.serving_container
      ? state.containers[state.serving_container]
      : undefined;
  }

  private requiredContainer(
    state: AgentState,
    digest: string,
    runId?: string,
  ): ManagedContainer {
    const container = this.find(state, digest, runId);
    if (!container) throw new Error(`Container not found for digest ${digest}`);
    return container;
  }

  private find(
    state: AgentState,
    digest: string,
    runId?: string,
  ): ManagedContainer | undefined {
    const containers = Object.values(state.containers).filter(
      (container) =>
        container.digest === digest && (!runId || container.run_id === runId),
    );
    return containers.at(-1);
  }

  private servingView(container: ManagedContainer): ServingContainer {
    return {
      run_id: container.run_id,
      digest: container.digest,
      container: container.container,
    };
  }

  private base(job: AgentJob) {
    return {
      schema_version: 1 as const,
      agent_id: this.agentId,
      job_id: job.job_id,
      run_id: job.run_id,
      action: job.action,
      attempt: job.attempt,
    };
  }

  private failed(job: AgentJob, error: unknown): AgentJobResult {
    return {
      ...this.base(job),
      result: "error",
      error: error instanceof Error ? error.message : "Agent job failed",
      finished_at: new Date().toISOString(),
    };
  }
}
