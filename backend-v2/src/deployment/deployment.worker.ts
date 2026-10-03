import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { Deployment, StageExecution } from '../database/schema.js';
import { ApplicationRepository } from '../application/application.repository.js';
import { DeploymentPaths } from './types/deployment.type.js';
import { DeploymentRepository } from './deployment.repository.js';
import { DeploymentArtifactService } from './deployment-artifact.service.js';
import { DeployStage } from './stages/deploy.stage.js';
import { PolicyStage } from './stages/policy.stage.js';
import { SignStage } from './stages/sign.stage.js';
import type {
  StageContext,
  StageOutcome,
  StageRunner,
} from './types/deployment.type.js';
import { TestStage } from './stages/test.stage.js';

@Injectable()
export class DeploymentWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: NodeJS.Timeout;
  private working = false;
  private readonly logger = new Logger(DeploymentWorker.name);

  constructor(
    private readonly repository: DeploymentRepository,
    private readonly applications: ApplicationRepository,
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly artifacts: DeploymentArtifactService,
    private readonly testStage: TestStage,
    private readonly policyStage: PolicyStage,
    private readonly signStage: SignStage,
    private readonly deployStage: DeployStage,
  ) {}

  onApplicationBootstrap(): void {
    this.repository.requeueInterrupted();
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.config.get('backend.workerPollMs', { infer: true }),
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.working) return;
    const deployment = this.repository.findQueued();
    if (!deployment || !this.repository.claim(deployment.id)) return;
    this.working = true;
    try {
      await this.execute(deployment.id);
    } catch (error) {
      this.logger.error(`Deployment worker failed: ${deployment.id}`, error);
      this.repository.update(deployment.id, {
        status: 'failed',
        error: 'Internal deployment worker error',
      });
    } finally {
      this.working = false;
    }
  }

  private async execute(deploymentId: string): Promise<void> {
    const paths = new DeploymentPaths(
      this.config.get('backend.cliTempDir', { infer: true }),
      deploymentId,
    );
    paths.ensure();
    let checkpointed = false;
    try {
      this.artifacts.restore(
        paths,
        this.repository.listArtifacts(deploymentId, true),
      );
      await this.executePipeline(deploymentId, paths);
      checkpointed = true;
    } finally {
      // DB 저장에 실패한 경우에만 복구용 임시 파일을 남깁니다.
      if (checkpointed) paths.cleanup();
    }
  }

  private async executePipeline(
    deploymentId: string,
    paths: DeploymentPaths,
  ): Promise<void> {
    let deployment = this.requiredDeployment(deploymentId);
    const application = this.applications.find(deployment.applicationId);
    if (!application) throw new Error('Application not found');

    if (
      !deployment.currentStage ||
      ['test', 'policy'].includes(deployment.currentStage)
    ) {
      if (
        !(await this.runStage(this.testStage, application, deployment, paths))
      )
        return;
      deployment = this.requiredDeployment(deploymentId);
      if (
        !(await this.runStage(this.policyStage, application, deployment, paths))
      )
        return;
      deployment = this.requiredDeployment(deploymentId);
      if (deployment.decision === 'block') {
        this.repository.update(deploymentId, {
          status: 'blocked',
          currentStage: 'policy',
        });
        return;
      }
      if (deployment.decision === 'needs_approval') {
        this.repository.update(deploymentId, {
          status: 'awaiting_approval',
          currentStage: 'sign',
        });
        return;
      }
    }

    deployment = this.requiredDeployment(deploymentId);
    if (deployment.currentStage !== 'deploy') {
      const approval = deployment.approver
        ? { approver: deployment.approver }
        : undefined;
      if (
        !(await this.runStage(
          this.signStage,
          application,
          deployment,
          paths,
          approval,
        ))
      ) {
        return;
      }
    }

    deployment = this.requiredDeployment(deploymentId);
    if (
      !(await this.runStage(this.deployStage, application, deployment, paths))
    ) {
      return;
    }
    this.repository.update(deploymentId, {
      status: 'succeeded',
      currentStage: 'deploy',
    });
  }

  private async runStage(
    runner: StageRunner,
    application: NonNullable<ReturnType<ApplicationRepository['find']>>,
    deployment: Deployment,
    paths: DeploymentPaths,
    approval?: { approver: string },
  ): Promise<boolean> {
    if (this.requiredDeployment(deployment.id).status === 'cancelled')
      return false;
    const sequence = { test: 1, policy: 2, sign: 3, deploy: 4 }[runner.name];
    const execution: StageExecution = {
      id: randomUUID(),
      deploymentId: deployment.id,
      sequence,
      attempt: this.repository.nextAttempt(deployment.id, runner.name),
      stage: runner.name,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      artifacts: {},
      summary: null,
      error: null,
    };
    this.repository.createStage(execution);
    this.repository.update(deployment.id, { currentStage: runner.name });
    // 재시도는 이전 산출물을 새 결과로 재사용하지 않습니다.
    rmSync(paths[runner.name], { recursive: true, force: true });
    mkdirSync(paths[runner.name], { recursive: true });

    const context: StageContext = {
      application,
      deployment: this.requiredDeployment(deployment.id),
      paths,
      ...(approval ? { approval } : {}),
    };
    let outcome: StageOutcome;
    try {
      outcome = await runner.run(context);
    } catch (error) {
      outcome = {
        status: 'failed',
        artifacts: {},
        error: 'Stage execution failed',
        summary: {
          details: error instanceof Error ? error.message : String(error),
        },
      };
    }

    // A successful build/test replaces the placeholder before artifact validation.
    // The patch is still committed only if every captured artifact is valid.
    const capturedDeployment =
      runner.name === 'test' && outcome.status === 'succeeded'
        ? {
            ...deployment,
            imageDigest:
              outcome.deploymentPatch?.imageDigest ?? deployment.imageDigest,
          }
        : deployment;
    const captured = this.artifacts.capture(
      paths,
      execution,
      capturedDeployment,
    );
    if (captured.error)
      outcome = {
        ...outcome,
        status: 'failed',
        error: captured.error,
        deploymentPatch: undefined,
        policyResult: undefined,
      };
    this.repository.checkpoint(
      captured.artifacts,
      captured.auditLogs,
      (artifactIds) => {
        this.repository.updateStage(execution.id, {
          status: outcome.status,
          exitCode: outcome.exitCode,
          finishedAt: new Date().toISOString(),
          artifacts: artifactIds,
          summary: outcome.summary,
          error: outcome.error,
        });
        if (outcome.deploymentPatch) {
          this.repository.update(deployment.id, outcome.deploymentPatch);
        }
        if (outcome.policyResult) {
          const timestamp = new Date().toISOString();
          this.repository.savePolicyResult({
            deploymentId: deployment.id,
            ...outcome.policyResult,
            planPath: null,
            piiPath: null,
            planArtifactId: artifactIds.plan ?? null,
            piiArtifactId: artifactIds.pii ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
        if (outcome.status === 'failed') {
          this.repository.update(deployment.id, {
            status: 'failed',
            error: `[${runner.name}] ${outcome.error ?? 'Stage failed'}`,
          });
        }
      },
    );
    rmSync(paths.decisionsLog, { force: true });
    return (
      outcome.status !== 'failed' &&
      this.requiredDeployment(deployment.id).status !== 'cancelled'
    );
  }

  private requiredDeployment(id: string): Deployment {
    const deployment = this.repository.find(id);
    if (!deployment) throw new Error('Deployment not found');
    return deployment;
  }
}
