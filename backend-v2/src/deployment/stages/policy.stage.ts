import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import {
  CommandRunner,
  npmCommand,
} from '../../infrastructure/command-runner.js';
import type { Deployment } from '../../database/schema.js';
import type {
  StageContext,
  StageOutcome,
  StageRunner,
} from '../types/deployment.type.js';
import { tail, canonicalJson } from '../types/deployment.type.js';
import type { DeploymentPlan as Plan } from '../types/deployment.type.js';

type Decision = NonNullable<Deployment['decision']>;
const exitDecisions: Record<number, Decision> = {
  0: 'allow',
  2: 'needs_approval',
  3: 'block',
};

@Injectable()
export class PolicyStage implements StageRunner {
  readonly name = 'policy' as const;

  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly runner: CommandRunner,
  ) {}

  async run(context: StageContext): Promise<StageOutcome> {
    return context.deployment.executionMode === 'cli'
      ? this.runCli(context)
      : this.runSkeleton(context);
  }

  private async runSkeleton(context: StageContext): Promise<StageOutcome> {
    const { application, deployment, paths } = context;
    const decision: Decision =
      application.testTemplate === 'block-test-failed'
        ? 'block'
        : application.requiresApproval
          ? 'needs_approval'
          : 'allow';
    const planWithoutHash = {
      run_id: deployment.id,
      app: application.name,
      digest: deployment.imageDigest,
      source_revision: deployment.sourceRevision,
      decision,
      targets: decision === 'block' ? [] : ['onprem', 'cloud_run'],
      failover_allowed: decision !== 'block',
      rules: [
        {
          id: 'skeleton',
          result: 'matched' as const,
          reason: '테스트용 정책 결과',
        },
      ],
      ...(decision === 'allow'
        ? {}
        : {
            requires: [
              {
                id: decision === 'block' ? 'fix_tests' : 'approval',
                rule_id: 'skeleton',
                allowed_targets: ['onprem', 'cloud_run'],
              },
            ],
          }),
    };
    const planHash = createHash('sha256')
      .update(canonicalJson(planWithoutHash))
      .digest('hex');
    const plan: Plan = { ...planWithoutHash, plan_hash: planHash };
    const planPath = join(paths.policy, 'plan.json');
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    appendFileSync(
      paths.decisionsLog,
      `${JSON.stringify({ kind: 'deploy', time: new Date().toISOString(), run_id: plan.run_id, digest: plan.digest, source_revision: plan.source_revision, decision, targets: plan.targets, rule_ids: ['skeleton'], plan_hash: planHash })}\n`,
      'utf8',
    );
    return {
      status: 'succeeded',
      exitCode:
        decision === 'allow' ? 0 : decision === 'needs_approval' ? 2 : 3,
      artifacts: { plan: paths.relative(planPath) },
      summary: { decision, mode: 'skeleton' },
      deploymentPatch: { decision },
      policyResult: {
        decision,
        planHash,
        targets: plan.targets,
        failoverAllowed: plan.failover_allowed,
        requires: plan.requires ?? [],
        planPath: paths.relative(planPath),
        piiPath: null,
      },
    };
  }

  private async runCli(context: StageContext): Promise<StageOutcome> {
    const { application, deployment, paths } = context;
    const testResult = join(paths.test, 'test_result.json');
    if (!existsSync(testResult)) {
      return {
        status: 'failed',
        artifacts: {},
        error: 'test_result.json not found',
      };
    }
    const repoRoot = this.config.get('backend.repoRoot', { infer: true });
    const result = await this.runner.run({
      command: npmCommand(this.config),
      cwd: join(repoRoot, 'policy'),
      timeoutMs: this.config.get('backend.policyTimeoutMs', { infer: true }),
      args: [
        'run',
        'stage',
        '--',
        '--src',
        application.sourcePath,
        '--test',
        testResult,
        '--policy',
        application.policyPath ?? 'policy.yaml',
        '--out-dir',
        paths.policy,
        '--log',
        paths.decisionsLog,
        '--source-revision',
        deployment.sourceRevision,
        '--json',
        '--explain',
      ],
    });
    if (result.timedOut) {
      return {
        status: 'failed',
        exitCode: result.code,
        artifacts: {},
        error: 'Policy CLI timed out',
      };
    }
    const decision =
      result.code === null ? undefined : exitDecisions[result.code];
    if (!decision) {
      return {
        status: 'failed',
        exitCode: result.code,
        artifacts: {},
        error: `Policy CLI failed with exit code ${result.code ?? 'unknown'}`,
        summary: { stdout: tail(result.stdout), stderr: tail(result.stderr) },
      };
    }
    const planPath = join(paths.policy, 'plan.json');
    let plan: Plan;
    try {
      plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
    } catch (error) {
      return {
        status: 'failed',
        exitCode: result.code,
        artifacts: {},
        error: 'Unable to read plan.json',
        summary: {
          details: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (
      plan.run_id !== deployment.id ||
      plan.digest !== deployment.imageDigest ||
      plan.source_revision !== deployment.sourceRevision ||
      plan.decision !== decision
    ) {
      return {
        status: 'failed',
        exitCode: result.code,
        artifacts: {},
        error: 'plan.json does not match the current deployment',
      };
    }
    return {
      status: 'succeeded',
      exitCode: result.code,
      artifacts: { plan: paths.relative(planPath) },
      summary: {
        decision,
        targets: plan.targets,
        failover_allowed: plan.failover_allowed,
        requires: plan.requires ?? [],
        mode: 'cli',
      },
      deploymentPatch: { decision },
      policyResult: {
        decision,
        planHash: plan.plan_hash,
        targets: plan.targets,
        failoverAllowed: plan.failover_allowed,
        requires: plan.requires ?? [],
        planPath: paths.relative(planPath),
        piiPath: null,
      },
    };
  }
}
