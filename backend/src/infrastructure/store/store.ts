/** 저장소 인터페이스. 지금은 메모리 구현만 있고, 관리형 DB 구현은 다음 단계 */
import type { DeploymentApp, DeploymentRun, StageExecution } from "../../pipeline/models.js";

export interface Store {
  createApp(app: DeploymentApp): Promise<DeploymentApp>;
  getApp(id: string): Promise<DeploymentApp | undefined>;
  listApps(): Promise<DeploymentApp[]>;

  createRun(run: DeploymentRun): Promise<DeploymentRun>;
  getRun(runId: string): Promise<DeploymentRun | undefined>;
  updateRun(runId: string, patch: Partial<DeploymentRun>): Promise<DeploymentRun>;
  listRuns(appId?: string): Promise<DeploymentRun[]>;

  createStage(stage: StageExecution): Promise<StageExecution>;
  updateStage(id: string, patch: Partial<StageExecution>): Promise<StageExecution>;
  listStages(runId: string): Promise<StageExecution[]>;
}
