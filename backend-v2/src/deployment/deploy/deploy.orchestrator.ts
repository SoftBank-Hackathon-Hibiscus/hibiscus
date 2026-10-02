import {
  DEPLOY_TARGETS,
  DeployRejected,
  type CloudRunPort,
  type DeployCheck,
  type DeployInput,
  type DeployResult,
  type DeployRouting,
  type DeployTarget,
  type DeployTargetStep,
  type HealthCheckerPort,
  type OnpremPort,
  type RoutingPort,
  type SignatureVerifierPort,
} from '../types/deploy-result.type.js';

export interface DeployOrchestratorDeps {
  verifier: SignatureVerifierPort;
  health: HealthCheckerPort;
  routing: RoutingPort;
  onprem: OnpremPort;
  /** 없으면 cloud_run 대상은 배포할 수 없다 (GCP 설정 없음) */
  cloudRun?: CloudRunPort;
  cloudRunUnavailableReason?: string;
  now?: () => Date;
}

interface CloudCandidate {
  step: DeployTargetStep;
  candidateUrl?: string;
}

interface OnpremCandidate {
  step: DeployTargetStep;
  localPort?: number;
  check?: DeployCheck;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * 서명 확인 → 대상별 후보(트래픽 0%) → 검사 → 전부 통과하면 전환 → 대표 경로 변경.
 * 하나라도 실패하면 전환하지 않고 후보만 정리한다 (held). 전환 중 실패하면 이미 전환한 Cloud Run 을 되돌린다.
 * 대표 경로 변경이 실패하면 새 버전이 트래픽을 받지 못하므로 activated 로 남기지 않고 전환한 대상을 모두 되돌린다.
 */
export class DeployOrchestrator {
  constructor(private readonly deps: DeployOrchestratorDeps) {}

  async run(input: DeployInput): Promise<DeployResult> {
    const now = this.deps.now ?? (() => new Date());
    const result: DeployResult = {
      run_id: input.deploymentId,
      digest: input.digest,
      image: null,
      decision: 'error',
      signature: null,
      targets_planned: [...input.sign.targets],
      failover_allowed: input.sign.failover_allowed,
      targets: [],
      checks: [],
      routing: { result: 'skipped' },
      started_at: now().toISOString(),
    };
    try {
      await this.execute(input, result);
    } catch (error) {
      result.decision = 'error';
      result.error = message(error);
    }
    result.finished_at = now().toISOString();
    return result;
  }

  private async execute(input: DeployInput, result: DeployResult) {
    // 1) 배포 전 거부: 클라우드를 건드리기 전에 끝낸다
    if (
      input.sign.run_id !== input.deploymentId ||
      input.sign.digest !== input.digest
    )
      throw new DeployRejected(
        'sign_result does not match the current deployment',
      );
    const unknown = input.sign.targets.filter(
      (target) => !(DEPLOY_TARGETS as readonly string[]).includes(target),
    );
    if (unknown.length)
      throw new DeployRejected(`Unknown deploy targets: ${unknown.join(', ')}`);
    const planned = DEPLOY_TARGETS.filter((target) =>
      input.sign.targets.includes(target),
    );
    if (planned.length === 0)
      throw new DeployRejected('sign_result has no deploy targets');
    if (planned.includes('cloud_run') && !this.deps.cloudRun)
      throw new DeployRejected(
        this.deps.cloudRunUnavailableReason ?? 'Cloud Run is not configured',
      );

    const { imageRef, key, tlog } = await this.deps.verifier.verify(
      input.sign,
      input.imageRepo,
    );
    result.image = imageRef;
    result.signature = {
      verified: true,
      ref: input.sign.signature_ref,
      key,
      ...(tlog ? { tlog } : {}),
    };

    // 2) 후보: 양쪽을 동시에 띄운다 (온프레는 Agent 결과를 기다리느라 오래 걸릴 수 있음)
    const [cloud, onprem] = await Promise.all([
      planned.includes('cloud_run')
        ? this.cloudCandidate(imageRef, input)
        : undefined,
      planned.includes('onprem')
        ? this.onpremCandidate(imageRef, input)
        : undefined,
    ]);
    for (const candidate of [cloud, onprem])
      if (candidate) result.targets.push(candidate.step);
    const liveCloud = cloud?.step.result === 'ok' ? cloud : undefined;
    const liveOnprem = onprem?.step.result === 'ok' ? onprem : undefined;
    const candidateFailed = [cloud, onprem].some(
      (candidate) => candidate?.step.result === 'error',
    );

    if (!liveCloud && !liveOnprem && !candidateFailed)
      throw new Error(
        'No target could be deployed (every planned target was skipped)',
      );

    // 3) 검사 (후보 하나라도 못 띄웠으면 검사 없이 정리로 간다)
    if (!candidateFailed) {
      if (liveCloud?.candidateUrl)
        result.checks.push(
          await this.deps.health.check(
            'cloud_run',
            liveCloud.candidateUrl,
            input.healthCheck,
          ),
        );
      if (liveOnprem?.check) result.checks.push(liveOnprem.check);
    }
    if (candidateFailed || result.checks.some((check) => !check.pass)) {
      await this.discard(input, result, cloud, liveOnprem);
      result.decision = 'held';
      result.error = candidateFailed
        ? 'A candidate could not be started; kept the current version'
        : 'Candidate checks failed; kept the current version';
      return;
    }

    // 4) 전환: Cloud Run 먼저 (되돌리기가 빠름), 그다음 온프레
    let cloudActivated = false;
    let cloudPrevious = '';
    let onpremActivated = false;
    let onpremPrevious: string | undefined;
    try {
      if (liveCloud) {
        const activated = await this.deps.cloudRun!.activate();
        cloudActivated = true;
        cloudPrevious = activated.previous;
        result.targets.push({
          target: 'cloud_run',
          phase: 'activate',
          result: 'ok',
          previous: activated.previous || null,
          serving: activated.serving,
        });
      }
      if (liveOnprem) {
        const activated = await this.deps.onprem.run({
          agentId: input.agentId!,
          runId: input.deploymentId,
          action: 'activate',
          digest: input.digest,
        });
        if (activated.status !== 'succeeded') {
          result.targets.push({
            target: 'onprem',
            phase: 'activate',
            result: 'error',
            job_id: activated.jobId,
            error: activated.error,
          });
          throw new Error(
            `On-prem activation failed: ${activated.error ?? activated.status}`,
          );
        }
        onpremActivated = true;
        onpremPrevious = activated.payload?.previous?.digest;
        result.targets.push({
          target: 'onprem',
          phase: 'activate',
          result: 'ok',
          job_id: activated.jobId,
          previous: activated.payload?.previous?.container ?? null,
          serving: activated.payload?.serving?.container ?? null,
        });
      }
    } catch (error) {
      result.error = message(error);
      result.decision = await this.revertCloud(
        cloudActivated,
        cloudPrevious,
        result,
      );
      if (liveOnprem) await this.discardOnprem(input, result);
      return;
    }

    // 5) 대표 경로: 온프레가 있으면 온프레, 없으면 Cloud Run
    result.routing = this.route(input, liveCloud, liveOnprem);
    if (result.routing.result === 'error') {
      // 대표 경로가 예전 대상을 가리킨 채로 남는다. 성공으로 기록하지 않고 전환한 대상을 되돌린다
      result.error = `Routing switch failed: ${result.routing.error ?? 'unknown error'}`;
      const cloudRestored = cloudActivated
        ? (await this.revertCloud(true, cloudPrevious, result)) ===
          'rolled_back'
        : true;
      const onpremRestored = onpremActivated
        ? await this.rollbackOnprem(input, result, onpremPrevious)
        : true;
      result.decision =
        cloudRestored && onpremRestored ? 'rolled_back' : 'error';
      return;
    }
    result.decision = 'activated';
  }

  private async cloudCandidate(
    imageRef: string,
    input: DeployInput,
  ): Promise<CloudCandidate> {
    try {
      const candidate = await this.deps.cloudRun!.candidate(
        imageRef,
        input.deploymentId,
      );
      return {
        step: {
          target: 'cloud_run',
          phase: 'candidate',
          result: 'ok',
          revision: candidate.revision,
          candidate_url: candidate.candidateUrl,
        },
        candidateUrl: candidate.candidateUrl,
      };
    } catch (error) {
      return {
        step: {
          target: 'cloud_run',
          phase: 'candidate',
          result: 'error',
          error: message(error),
        },
      };
    }
  }

  private async onpremCandidate(
    imageRef: string,
    input: DeployInput,
  ): Promise<OnpremCandidate> {
    if (!input.agentId)
      return {
        step: {
          target: 'onprem',
          phase: 'candidate',
          result: 'skipped',
          reason: 'No agent is assigned to this application',
        },
      };
    try {
      const outcome = await this.deps.onprem.run({
        agentId: input.agentId,
        runId: input.deploymentId,
        action: 'candidate',
        digest: input.digest,
        image: imageRef,
        planHash: input.sign.plan_hash,
      });
      const candidate = outcome.payload?.candidate;
      if (outcome.status !== 'succeeded' || !candidate)
        return {
          step: {
            target: 'onprem',
            phase: 'candidate',
            result: 'error',
            job_id: outcome.jobId,
            error: outcome.error ?? 'Agent returned no candidate',
          },
        };
      const localPort = Number(new URL(candidate.url).port);
      const check = outcome.payload?.check as
        { pass?: unknown; checks?: unknown } | undefined;
      return {
        step: {
          target: 'onprem',
          phase: 'candidate',
          result: 'ok',
          job_id: outcome.jobId,
          container: candidate.container,
          candidate_url: candidate.url,
        },
        localPort:
          Number.isInteger(localPort) && localPort > 0 ? localPort : undefined,
        check: {
          target: 'onprem',
          mode: 'candidate',
          // Agent 는 검사에 실패하면 후보를 지우고 error 를 보낸다. ok 결과는 검사 통과로 본다
          pass: check?.pass === undefined ? true : check.pass === true,
          url: candidate.url,
          checker: 'onprem-agent',
          checks: Array.isArray(check?.checks) ? check.checks : [],
        },
      };
    } catch (error) {
      return {
        step: {
          target: 'onprem',
          phase: 'candidate',
          result: 'error',
          error: message(error),
        },
      };
    }
  }

  private async discard(
    input: DeployInput,
    result: DeployResult,
    cloud: CloudCandidate | undefined,
    liveOnprem: OnpremCandidate | undefined,
  ) {
    if (cloud) {
      // 실패한 후보도 태그가 붙어 있을 수 있어서 시도한 경우 항상 정리한다
      try {
        await this.deps.cloudRun!.discard();
        result.targets.push({
          target: 'cloud_run',
          phase: 'discard',
          result: 'ok',
        });
      } catch (error) {
        result.targets.push({
          target: 'cloud_run',
          phase: 'discard',
          result: 'error',
          error: message(error),
        });
      }
    }
    if (liveOnprem) await this.discardOnprem(input, result);
  }

  private async discardOnprem(input: DeployInput, result: DeployResult) {
    try {
      const outcome = await this.deps.onprem.run({
        agentId: input.agentId!,
        runId: input.deploymentId,
        action: 'discard',
        digest: input.digest,
      });
      result.targets.push({
        target: 'onprem',
        phase: 'discard',
        result: outcome.status === 'succeeded' ? 'ok' : 'error',
        job_id: outcome.jobId,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    } catch (error) {
      result.targets.push({
        target: 'onprem',
        phase: 'discard',
        result: 'error',
        error: message(error),
      });
    }
  }

  private async rollbackOnprem(
    input: DeployInput,
    result: DeployResult,
    previousDigest: string | undefined,
  ): Promise<boolean> {
    if (!previousDigest) {
      result.targets.push({
        target: 'onprem',
        phase: 'rollback',
        result: 'error',
        error: 'No previous container was serving on the agent',
      });
      return false;
    }
    try {
      const outcome = await this.deps.onprem.run({
        agentId: input.agentId!,
        runId: input.deploymentId,
        action: 'rollback',
        digest: input.digest,
        toDigest: previousDigest,
      });
      const ok = outcome.status === 'succeeded';
      result.targets.push({
        target: 'onprem',
        phase: 'rollback',
        result: ok ? 'ok' : 'error',
        job_id: outcome.jobId,
        ...(ok
          ? { serving: outcome.payload?.serving?.container ?? null }
          : { error: outcome.error ?? outcome.status }),
      });
      return ok;
    } catch (error) {
      result.targets.push({
        target: 'onprem',
        phase: 'rollback',
        result: 'error',
        error: message(error),
      });
      return false;
    }
  }

  private async revertCloud(
    activated: boolean,
    previous: string,
    result: DeployResult,
  ): Promise<DeployResult['decision']> {
    if (!activated) return 'error';
    if (!previous) {
      result.targets.push({
        target: 'cloud_run',
        phase: 'rollback',
        result: 'error',
        error: 'No previous revision was serving 100% of traffic',
      });
      return 'error';
    }
    try {
      await this.deps.cloudRun!.rollback(previous);
      result.targets.push({
        target: 'cloud_run',
        phase: 'rollback',
        result: 'ok',
        serving: previous,
      });
      return 'rolled_back';
    } catch (error) {
      result.targets.push({
        target: 'cloud_run',
        phase: 'rollback',
        result: 'error',
        error: message(error),
      });
      return 'error';
    }
  }

  private route(
    input: DeployInput,
    cloud: CloudCandidate | undefined,
    onprem: OnpremCandidate | undefined,
  ): DeployRouting {
    try {
      let primary: { id: string; kind: DeployTarget } | undefined;
      const routing: DeployRouting = { result: 'ok' };
      if (onprem) {
        if (!onprem.localPort)
          throw new Error('Agent candidate URL has no local port');
        primary = {
          kind: 'onprem',
          id: this.deps.routing.ensureTarget({
            applicationId: input.applicationId,
            deploymentId: input.deploymentId,
            kind: 'onprem',
            agentId: input.agentId!,
            localPort: onprem.localPort,
            enabled: true,
          }),
        };
      }
      if (cloud?.candidateUrl) {
        // 온프레가 주 경로일 때 Cloud Run 은 대기 대상. 정책이 failover 를 막았으면 비활성으로 둔다
        const enabled = !onprem || input.sign.failover_allowed;
        const id = this.deps.routing.ensureTarget({
          applicationId: input.applicationId,
          deploymentId: input.deploymentId,
          kind: 'cloud_run',
          url: this.deps.cloudRun!.serviceUrl(cloud.candidateUrl),
          enabled,
        });
        if (primary) {
          routing.standby_target_id = id;
          routing.standby_enabled = enabled;
        } else primary = { id, kind: 'cloud_run' };
      }
      if (!primary) return { result: 'skipped', reason: 'No active target' };
      routing.target_id = primary.id;
      routing.kind = primary.kind;
      routing.revision = this.deps.routing.switchTo(
        input.applicationId,
        primary.id,
        input.changedBy,
        `deploy ${input.deploymentId}`,
      );
      return routing;
    } catch (error) {
      return { result: 'error', error: message(error) };
    }
  }
}
