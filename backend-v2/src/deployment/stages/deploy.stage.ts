import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentJobService } from '../../agent/agent-job.service.js';
import { ApplicationRepository } from '../../application/application.repository.js';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { DeployConfig } from '../../config/configs/deploy.config.js';
import { CommandRunner } from '../../infrastructure/command-runner.js';
import { RoutingService } from '../../routing/routing.service.js';
import { CloudRunClient } from '../deploy/cloud-run.client.js';
import { DeployOrchestrator } from '../deploy/deploy.orchestrator.js';
import { HttpHealthChecker } from '../deploy/http-health.checker.js';
import { OnpremClient } from '../deploy/onprem.client.js';
import { DeploymentRepository } from '../deployment.repository.js';
import { RoutingAdapter } from '../deploy/routing.adapter.js';
import { SignatureVerifier } from '../deploy/signature.verifier.js';
import type { DeployResult } from '../types/deploy-result.type.js';
import type {
  DeploymentSignResult,
  StageContext,
  StageOutcome,
  StageRunner,
} from '../types/deployment.type.js';

const EXIT_CODES: Record<DeployResult['decision'], number> = {
  activated: 0,
  held: 3,
  rolled_back: 4,
  error: 1,
};

/**
 * 배포 단계.
 *   off  → skipped
 *   dry  → 아직 없음 (실패로 기록)
 *   real → 서명 확인 → Cloud Run·온프레 후보 → 검사 → 전환 → 대표 경로 변경
 * 결과는 <run>/deploy/deploy_result.json 으로 남기고, Worker 가 DB 산출물로 저장한다.
 * Agent 작업·라우팅은 태현님 모듈의 서비스를 ModuleRef 로 가져다 쓴다
 * (AgentModule·RoutingModule 이 DeploymentModule 을 import 하고 있어서 직접 import 하면 순환 의존이 생김).
 */
@Injectable()
export class DeployStage implements StageRunner {
  readonly name = 'deploy' as const;

  constructor(
    private readonly config: ConfigService<BackendConfig & DeployConfig, true>,
    private readonly runner: CommandRunner,
    private readonly applications: ApplicationRepository,
    private readonly deployments: DeploymentRepository,
    private readonly moduleRef: ModuleRef,
  ) {}

  async run(context: StageContext): Promise<StageOutcome> {
    const mode = this.config.get('backend.deployMode', { infer: true });
    if (mode === 'off') {
      return {
        status: 'skipped',
        artifacts: {},
        summary: { mode, reason: '실제 배포 조율기를 호출하지 않음' },
        deploymentPatch: { deploymentPerformed: false },
      };
    }
    if (mode === 'dry') {
      return {
        status: 'failed',
        artifacts: {},
        error: 'DEPLOY_MODE=dry is not implemented',
        deploymentPatch: { deploymentPerformed: false },
      };
    }

    const { deployment, application, paths } = context;
    // 서명 단계와 같은 조건을 배포 직전에 한 번 더 확인한다 (서명 단계를 거치지 않은 경로 방지)
    if (deployment.digestSource !== 'registry') {
      return this.failed('Real deploy requires a registry image digest');
    }
    if (!deployment.sourceRevisionVerified) {
      return this.failed('Real deploy requires a verified source revision');
    }
    const signPath = join(paths.sign, 'sign_result.json');
    if (!existsSync(signPath))
      return this.failed('sign_result.json is missing');
    const sign = JSON.parse(
      readFileSync(signPath, 'utf8'),
    ) as DeploymentSignResult;
    const view = this.applications.getView(application.id);
    if (!view) return this.failed('Application not found');
    const agent =
      view.agents.find((item) => item.status === 'online') ??
      view.agents.find((item) => item.status !== 'revoked');

    const result = await this.orchestrator(application).run({
      deploymentId: deployment.id,
      digest: deployment.imageDigest,
      applicationId: application.id,
      imageRepo: application.imageRepo,
      sign,
      agentId: agent?.id ?? null,
      healthCheck: view.healthCheck,
      environment: this.deployments.environment(deployment.id, 'runtime'),
      changedBy: deployment.requester,
    });

    const output = join(paths.deploy, 'deploy_result.json');
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    const summary = {
      decision: result.decision,
      image: result.image,
      targets: result.targets.map(
        ({ target, phase, result: stepResult }) =>
          `${target}:${phase}:${stepResult}`,
      ),
      routing: result.routing,
      ...(result.error ? { error: result.error } : {}),
    };
    // 새 버전이 실제로 트래픽을 받는 경우만 배포 완료로 본다.
    // rolled_back(전환 후 되돌림, 대표 경로 변경 실패 포함)은 실패로 기록한다
    if (result.decision === 'activated') {
      return {
        status: 'succeeded',
        exitCode: 0,
        artifacts: { deploy_result: paths.relative(output) },
        summary,
        deploymentPatch: { deploymentPerformed: true },
      };
    }
    return {
      status: 'failed',
      exitCode: EXIT_CODES[result.decision],
      artifacts: { deploy_result: paths.relative(output) },
      summary,
      error: `${result.decision}: ${result.error ?? 'Deployment did not complete'}`,
      deploymentPatch: { deploymentPerformed: false },
    };
  }

  private orchestrator(application: StageContext['application']) {
    const deploy = this.config.get('deploy', { infer: true });
    const repoRoot = this.config.get('backend.repoRoot', { infer: true });
    const scriptsDir = deploy.cloudRunScriptsDir
      ? resolve(deploy.cloudRunScriptsDir)
      : join(repoRoot, 'deploy', 'cloudrun');
    const publicKey = deploy.cosignPublicKey
      ? resolve(deploy.cosignPublicKey)
      : join(repoRoot, 'signer', 'keys', 'cosign.pub');
    return new DeployOrchestrator({
      verifier: new SignatureVerifier(this.runner, {
        cosignCommand: deploy.cosignCommand,
        publicKey,
        cwd: repoRoot,
        timeoutMs: deploy.scriptTimeoutMs,
        ignoreTlog: deploy.cosignIgnoreTlog,
      }),
      health: new HttpHealthChecker(),
      routing: new RoutingAdapter(
        this.moduleRef.get(RoutingService, { strict: false }),
      ),
      onprem: new OnpremClient(
        this.moduleRef.get(AgentJobService, { strict: false }),
        {
          candidateTimeoutMs: deploy.candidateTimeoutMs,
          actionTimeoutMs: deploy.actionTimeoutMs,
          pollMs: deploy.jobPollMs,
        },
      ),
      ...(deploy.projectId
        ? {
            cloudRun: new CloudRunClient(this.runner, {
              scriptsDir,
              projectId: deploy.projectId,
              region: deploy.region,
              service: deploy.cloudRunService || application.slug,
              tag: deploy.cloudRunTag,
              containerPort: application.containerPort,
              timeoutMs: deploy.scriptTimeoutMs,
            }),
          }
        : {
            cloudRunUnavailableReason:
              'GCP_PROJECT_ID is not set; cannot deploy to cloud_run',
          }),
    });
  }

  private failed(error: string): StageOutcome {
    return {
      status: 'failed',
      artifacts: {},
      error,
      deploymentPatch: { deploymentPerformed: false },
    };
  }
}
