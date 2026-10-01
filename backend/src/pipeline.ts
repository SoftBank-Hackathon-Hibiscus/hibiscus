/**
 * 파이프라인 서비스: run 생성 → 테스트 stub → 정책 → 서명 → 배포 순서로 단계를 부르고 상태를 기록한다.
 * 백엔드는 "호출하고 상태만 기록" 한다. 판단은 각 단계 모듈이 한다.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type ApprovalProvider, ApprovalRefusedError } from "./approval/provider.js";
import type { CommandRunner } from "./command-runner.js";
import type { Config } from "./config.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { resolveSourceRevision } from "./git.js";
import type { ApproveInput, CreateAppInput, CreateRunInput, DeploymentApp, DeploymentRun, StageExecution, StageName } from "./models.js";
import { RunPaths } from "./paths.js";
import { placeholderDigest } from "./stages/test-stub.js";
import type { StageContext, StageOutcome, StageRunner } from "./stages/types.js";
import type { Store } from "./store/store.js";

export interface PipelineDeps {
  config: Config;
  store: Store;
  runner: CommandRunner;
  approvals: ApprovalProvider;
  stages: Record<StageName, StageRunner>;
}

export interface RunView {
  run: DeploymentRun;
  stages: StageExecution[];
}

const now = () => new Date().toISOString();

export class PipelineService {
  private readonly inflight = new Map<string, Promise<void>>();
  /** 승인 처리 중인 run. 같은 run 에 거의 동시에 온 승인 요청 중 먼저 시작한 것만 진행한다 (프로세스 안 잠금) */
  private readonly approving = new Set<string>();

  constructor(private readonly deps: PipelineDeps) {}

  // ---- 앱 ----

  async createApp(input: CreateAppInput): Promise<DeploymentApp> {
    const srcPath = resolve(this.deps.config.repoRoot, input.src_path);
    let isDir = false;
    try {
      isDir = statSync(srcPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new ValidationError(`src_path 가 폴더가 아니거나 없음: ${srcPath}`);

    const app: DeploymentApp = {
      id: randomUUID(),
      name: input.name,
      src_path: srcPath,
      image_repo: input.image_repo,
      ...(input.repo !== undefined ? { repo: input.repo } : {}),
      ...(input.default_branch !== undefined ? { default_branch: input.default_branch } : {}),
      ...(input.policy_path !== undefined ? { policy_path: input.policy_path } : {}),
      test_template: input.test_template,
      created_at: now(),
    };
    return this.deps.store.createApp(app);
  }

  listApps(): Promise<DeploymentApp[]> {
    return this.deps.store.listApps();
  }

  async getApp(id: string): Promise<DeploymentApp> {
    const app = await this.deps.store.getApp(id);
    if (!app) throw new NotFoundError(`app 없음: ${id}`);
    return app;
  }

  // ---- run ----

  /** 수동 실행. source_revision 을 확정하고 run 을 만든 뒤 백그라운드로 단계를 돌린다 */
  async startRun(appId: string, input: CreateRunInput): Promise<DeploymentRun> {
    const app = await this.getApp(appId);
    const revision = await resolveSourceRevision(this.deps.runner, app.src_path, input.source_revision);

    const runId = randomUUID();
    const paths = new RunPaths(this.deps.config.workDir, runId);
    const t = now();
    const run: DeploymentRun = {
      run_id: runId,
      app_id: app.id,
      trigger: "manual",
      source_revision: revision.source_revision,
      source_revision_verified: revision.verified,
      digest: input.digest ?? placeholderDigest(runId),
      digest_source: input.digest !== undefined ? "registry" : "placeholder",
      status: "queued",
      current_stage: null,
      requester: input.requester,
      work_dir: paths.relative(paths.root),
      execution_mode: "skeleton",
      deployment_performed: false,
      created_at: t,
      updated_at: t,
    };
    await this.deps.store.createRun(run);
    paths.ensureDirs();
    this.track(runId, this.execute(app, runId, paths));
    return run;
  }

  /** needs_approval 로 멈춘 run 을 승인하고 서명·배포를 이어서 돌린다 */
  async approve(runId: string, input: ApproveInput): Promise<DeploymentRun> {
    if (this.approving.has(runId)) throw new ConflictError("같은 run 의 승인을 이미 처리하는 중");
    this.approving.add(runId);
    try {
      const run = await this.getRun(runId);
      if (run.status !== "awaiting_approval") throw new ConflictError(`승인 대기 상태가 아님 (status=${run.status})`);
      // signer 도 본인 승인을 거절하지만, 그 전에 막아야 run 이 failed 로 끝나지 않고 다른 사람이 승인할 수 있다
      if (input.approver === run.requester) {
        throw new ApprovalRefusedError(`요청자 본인(${run.requester})은 승인할 수 없다. 다른 사람이 승인해야 한다`);
      }
      const app = await this.getApp(run.app_id);
      const resolved = await this.deps.approvals.resolve({ run, approver: input.approver });

      const updated = await this.deps.store.updateRun(runId, { status: "running", current_stage: "sign" });
      const paths = new RunPaths(this.deps.config.workDir, runId);
      this.track(runId, this.continueAfterPolicy(app, runId, paths, { approver: resolved.approver }));
      return updated;
    } finally {
      this.approving.delete(runId);
    }
  }

  async getRun(runId: string): Promise<DeploymentRun> {
    const run = await this.deps.store.getRun(runId);
    if (!run) throw new NotFoundError(`run 없음: ${runId}`);
    return run;
  }

  async getRunView(runId: string): Promise<RunView> {
    const run = await this.getRun(runId);
    const stages = await this.deps.store.listStages(runId);
    return { run, stages };
  }

  /** 백그라운드 실행이 끝날 때까지 기다린다 (테스트·CLI 용) */
  async waitFor(runId: string): Promise<void> {
    const p = this.inflight.get(runId);
    if (p) await p;
  }

  // ---- 내부 ----

  private track(runId: string, work: Promise<void>): void {
    const wrapped = work
      .catch(async (e: unknown) => {
        await this.deps.store.updateRun(runId, { status: "failed", error: `내부 오류: ${e instanceof Error ? e.message : String(e)}` });
      })
      .finally(() => {
        if (this.inflight.get(runId) === wrapped) this.inflight.delete(runId);
      });
    this.inflight.set(runId, wrapped);
  }

  private async execute(app: DeploymentApp, runId: string, paths: RunPaths): Promise<void> {
    await this.deps.store.updateRun(runId, { status: "running" });

    const test = await this.runStage("test", app, runId, paths);
    if (test.status !== "succeeded") return;

    const policy = await this.runStage("policy", app, runId, paths);
    if (policy.status !== "succeeded") return;

    const run = await this.getRun(runId);
    if (run.decision === "block") {
      await this.deps.store.updateRun(runId, { status: "blocked", current_stage: "policy" });
      return;
    }
    if (run.decision === "needs_approval") {
      await this.deps.store.updateRun(runId, { status: "awaiting_approval", current_stage: "sign" });
      return;
    }
    await this.continueAfterPolicy(app, runId, paths, undefined);
  }

  private async continueAfterPolicy(app: DeploymentApp, runId: string, paths: RunPaths, approval: { approver: string } | undefined): Promise<void> {
    const sign = await this.runStage("sign", app, runId, paths, approval);
    if (sign.status !== "succeeded") return;

    const deploy = await this.runStage("deploy", app, runId, paths);
    if (deploy.status === "failed") return;

    await this.deps.store.updateRun(runId, { status: "succeeded", current_stage: "deploy" });
  }

  /** 단계 하나를 StageExecution 으로 감싸 실행하고 run 에 반영한다. 실패하면 run 을 failed 로 */
  private async runStage(stage: StageName, app: DeploymentApp, runId: string, paths: RunPaths, approval?: { approver: string }): Promise<StageOutcome> {
    const { store, config, runner, stages } = this.deps;
    const previous = (await store.listStages(runId)).filter((s) => s.stage === stage);
    const execution: StageExecution = {
      id: randomUUID(),
      run_id: runId,
      stage,
      attempt: previous.length + 1,
      status: "running",
      started_at: now(),
      artifacts: {},
    };
    await store.createStage(execution);
    await store.updateRun(runId, { current_stage: stage });

    const run = await this.getRun(runId);
    const ctx: StageContext = { config, runner, app, run, paths, ...(approval ? { approval } : {}) };

    let outcome: StageOutcome;
    try {
      outcome = await stages[stage].run(ctx);
    } catch (e) {
      outcome = { status: "failed", artifacts: {}, error: `단계 실행 중 예외: ${e instanceof Error ? e.message : String(e)}` };
    }

    await store.updateStage(execution.id, {
      status: outcome.status,
      ...(outcome.exit_code !== undefined ? { exit_code: outcome.exit_code } : {}),
      finished_at: now(),
      artifacts: outcome.artifacts,
      ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });

    const patch: Partial<DeploymentRun> = { ...outcome.runPatch };
    if (outcome.status === "failed") {
      patch.status = "failed";
      patch.error = `[${stage}] ${outcome.error ?? "실패"}`;
    }
    await store.updateRun(runId, patch);
    return outcome;
  }
}
