/** 메모리 저장소. 프로세스가 끝나면 사라진다 (개발·테스트용) */
import type { DeploymentApp, DeploymentRun, StageExecution } from "../../pipeline/models.js";
import type { Store } from "./store.js";

export class NotFoundInStore extends Error {}

export class MemoryStore implements Store {
  private readonly apps = new Map<string, DeploymentApp>();
  private readonly runs = new Map<string, DeploymentRun>();
  private readonly stages = new Map<string, StageExecution>();

  async createApp(app: DeploymentApp): Promise<DeploymentApp> {
    this.apps.set(app.id, structuredClone(app));
    return structuredClone(app);
  }

  async getApp(id: string): Promise<DeploymentApp | undefined> {
    const app = this.apps.get(id);
    return app ? structuredClone(app) : undefined;
  }

  async listApps(): Promise<DeploymentApp[]> {
    return [...this.apps.values()].map((a) => structuredClone(a));
  }

  async createRun(run: DeploymentRun): Promise<DeploymentRun> {
    this.runs.set(run.run_id, structuredClone(run));
    return structuredClone(run);
  }

  async getRun(runId: string): Promise<DeploymentRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async updateRun(runId: string, patch: Partial<DeploymentRun>): Promise<DeploymentRun> {
    const current = this.runs.get(runId);
    if (!current) throw new NotFoundInStore(`run 없음: ${runId}`);
    const next: DeploymentRun = { ...current, ...structuredClone(patch), updated_at: new Date().toISOString() };
    this.runs.set(runId, next);
    return structuredClone(next);
  }

  async listRuns(appId?: string): Promise<DeploymentRun[]> {
    return [...this.runs.values()].filter((r) => appId === undefined || r.app_id === appId).map((r) => structuredClone(r));
  }

  async createStage(stage: StageExecution): Promise<StageExecution> {
    this.stages.set(stage.id, structuredClone(stage));
    return structuredClone(stage);
  }

  async updateStage(id: string, patch: Partial<StageExecution>): Promise<StageExecution> {
    const current = this.stages.get(id);
    if (!current) throw new NotFoundInStore(`stage 없음: ${id}`);
    const next: StageExecution = { ...current, ...structuredClone(patch) };
    this.stages.set(id, next);
    return structuredClone(next);
  }

  async listStages(runId: string): Promise<StageExecution[]> {
    return [...this.stages.values()]
      .filter((s) => s.run_id === runId)
      .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.attempt - b.attempt))
      .map((s) => structuredClone(s));
  }
}
