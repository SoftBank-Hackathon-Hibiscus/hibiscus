import { redactDeploymentOutput } from '../../infrastructure/command-diagnostics.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import {
  CommandRunner,
  npmCommand,
} from '../../infrastructure/command-runner.js';
import type {
  StageContext,
  StageOutcome,
  StageRunner,
} from '../types/deployment.type.js';
import { tail, canonicalJson } from '../types/deployment.type.js';
import type {
  DeploymentPlan,
  DeploymentSignResult,
} from '../types/deployment.type.js';

@Injectable()
export class SignStage implements StageRunner {
  readonly name = 'sign' as const;

  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly runner: CommandRunner,
  ) {}

  async run(context: StageContext): Promise<StageOutcome> {
    if (context.deployment.decision === 'block') {
      return {
        status: 'failed',
        artifacts: {},
        error: 'Blocked deployments cannot be signed',
      };
    }
    if (context.deployment.decision === 'needs_approval' && !context.approval) {
      return {
        status: 'failed',
        artifacts: {},
        error: 'Approval information is missing',
      };
    }
    if (context.deployment.executionMode === 'skeleton') {
      const { deployment, paths, approval } = context;
      const plan = JSON.parse(
        readFileSync(join(paths.policy, 'plan.json'), 'utf8'),
      ) as DeploymentPlan;
      const approver = approval?.approver ?? 'auto';
      if (approval) {
        writeFileSync(
          join(paths.sign, 'approval.json'),
          JSON.stringify({
            run_id: plan.run_id,
            digest: plan.digest,
            plan_hash: plan.plan_hash,
            plan_sha256: createHash('sha256')
              .update(canonicalJson(plan))
              .digest('hex'),
            requester: deployment.requester,
            approver,
            approved_at: new Date().toISOString(),
          }),
          'utf8',
        );
      }
      const signResult = {
        run_id: plan.run_id,
        digest: plan.digest,
        source_revision: plan.source_revision,
        plan_hash: plan.plan_hash,
        targets: plan.targets,
        failover_allowed: plan.failover_allowed,
        requester: deployment.requester,
        approver,
        signature_ref: `dry-run:skeleton:${deployment.id}`,
        signed_at: new Date().toISOString(),
      };
      const output = join(paths.sign, 'sign_result.json');
      writeFileSync(output, JSON.stringify(signResult), 'utf8');
      appendFileSync(
        paths.decisionsLog,
        `${JSON.stringify({ kind: 'sign', time: signResult.signed_at, run_id: plan.run_id, digest: plan.digest, source_revision: plan.source_revision, plan_hash: plan.plan_hash, result: 'signed', requester: deployment.requester, approver, reason: null, signature_ref: signResult.signature_ref })}\n`,
        'utf8',
      );
      return {
        status: 'succeeded',
        exitCode: 0,
        artifacts: { sign_result: paths.relative(output) },
        summary: { mode: 'skeleton', approver: context.approval?.approver },
      };
    }
    return this.runCli(context);
  }

  private async runCli(context: StageContext): Promise<StageOutcome> {
    const { application, deployment, paths, approval } = context;
    if (this.config.get('backend.signerMode', { infer: true }) === 'real') {
      if (!deployment.sourceRevisionVerified) {
        return {
          status: 'failed',
          artifacts: {},
          error: 'Real signing requires a verified source revision',
        };
      }
      if (deployment.digestSource !== 'registry') {
        return {
          status: 'failed',
          artifacts: {},
          error: 'Real signing requires a registry image digest',
        };
      }
    }
    const repoRoot = this.config.get('backend.repoRoot', { infer: true });
    const planPath = join(paths.policy, 'plan.json');
    const common = {
      command: npmCommand(this.config),
      cwd: join(repoRoot, 'signer'),
      timeoutMs: this.config.get('backend.signerTimeoutMs', { infer: true }),
    };
    let approvalPath: string | undefined;
    if (approval) {
      approvalPath = join(paths.sign, 'approval.json');
      const approved = await this.runner.run({
        ...common,
        args: [
          'run',
          'approve',
          '--',
          '--plan',
          planPath,
          '--requester',
          deployment.requester,
          '--approver',
          approval.approver,
          '--out',
          approvalPath,
        ],
      });
      if (approved.code !== 0) {
        return {
          status: 'failed',
          exitCode: approved.code,
          artifacts: {},
          error: `Approval CLI failed with exit code ${approved.code ?? 'unknown'}`,
          summary: {
            stdout: tail(
              redactDeploymentOutput(
                approved.stdout,
                context.diagnosticSecrets ?? [],
              ),
            ),
            stderr: tail(
              redactDeploymentOutput(
                approved.stderr,
                context.diagnosticSecrets ?? [],
              ),
            ),
          },
        };
      }
    }
    const output = join(paths.sign, 'sign_result.json');
    const args = [
      'run',
      'sign',
      '--',
      '--plan',
      planPath,
      '--requester',
      deployment.requester,
    ];
    if (approvalPath) args.push('--approval', approvalPath);
    args.push(
      '--image-repo',
      application.imageRepo,
      '--out',
      output,
      '--log',
      paths.decisionsLog,
    );
    if (this.config.get('backend.signerMode', { infer: true }) === 'dry')
      args.push('--dry-run');
    const result = await this.runner.run({ ...common, args });
    if (result.code !== 0 || !existsSync(output)) {
      return {
        status: 'failed',
        exitCode: result.code,
        artifacts: {},
        error: result.timedOut
          ? 'Signer CLI timed out'
          : `Signer CLI failed or produced no result (exit code ${result.code ?? 'unknown'})`,
        summary: {
          stdout: tail(
            redactDeploymentOutput(
              result.stdout,
              context.diagnosticSecrets ?? [],
            ),
          ),
          stderr: tail(
            redactDeploymentOutput(
              result.stderr,
              context.diagnosticSecrets ?? [],
            ),
          ),
        },
      };
    }
    const signResult = JSON.parse(
      readFileSync(output, 'utf8'),
    ) as DeploymentSignResult;
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as DeploymentPlan;
    if (
      signResult.run_id !== deployment.id ||
      signResult.digest !== deployment.imageDigest ||
      signResult.source_revision !== deployment.sourceRevision ||
      signResult.plan_hash !== plan.plan_hash ||
      canonicalJson(signResult.targets) !== canonicalJson(plan.targets) ||
      signResult.failover_allowed !== plan.failover_allowed ||
      signResult.requester !== deployment.requester ||
      signResult.approver !== (approval?.approver ?? 'auto')
    ) {
      return {
        status: 'failed',
        exitCode: result.code,
        artifacts: {},
        error: 'sign_result.json does not match the current deployment',
      };
    }
    return {
      status: 'succeeded',
      exitCode: 0,
      artifacts: { sign_result: paths.relative(output) },
      summary: signResult,
    };
  }
}
