import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { Application, Deployment } from '../../database/schema.js';
import { CommandRunner } from '../../infrastructure/command-runner.js';
import { PolicyStage } from '../stages/policy.stage.js';
import {
  canonicalJson,
  DeploymentPaths,
  type DeploymentPlan,
  type StageContext,
} from '../types/deployment.type.js';

describe('PolicyStage application policy', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function context() {
    const sourcePath = mkdtempSync(join(tmpdir(), 'hibiscus-policy-source-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hibiscus-policy-work-'));
    temporaryDirectories.push(sourcePath, workDir);
    const paths = new DeploymentPaths(workDir, 'deployment-1');
    paths.ensure();
    writeFileSync(join(paths.test, 'test_result.json'), '{}\n', 'utf8');
    return {
      sourcePath,
      context: {
        application: {
          id: 'application-1',
          name: 'example',
          sourcePath,
        } as Application,
        deployment: {
          id: 'deployment-1',
          imageDigest: `sha256:${'a'.repeat(64)}`,
          sourceRevision: 'a'.repeat(40),
          executionMode: 'cli',
        } as Deployment,
        paths,
      } satisfies StageContext,
    };
  }

  function stage(run = vi.fn()) {
    const config = {
      get: vi.fn((key: string) => {
        const values: Record<string, unknown> = {
          'backend.parityTestMode': 'fixture',
          'backend.repoRoot': process.cwd() + '/..',
          'backend.policyTimeoutMs': 1_000,
          'backend.npmCommand': 'npm',
        };
        return values[key];
      }),
    } as unknown as ConfigService<BackendConfig, true>;
    const runner = { run } as unknown as CommandRunner;
    return { policy: new PolicyStage(config, runner), run };
  }

  it('skips policy evaluation when .hibiscus/policy.yaml is absent', async () => {
    const { context: stageContext } = context();
    const { policy, run } = stage();

    const outcome = await policy.run(stageContext);

    expect(run).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'skipped',
      exitCode: 0,
      deploymentPatch: { decision: 'allow' },
      policyResult: {
        decision: 'allow',
        targets: ['onprem', 'cloud_run'],
        failoverAllowed: true,
        policyPath: '.hibiscus/policy.yaml',
        policyHash: null,
        skipped: true,
      },
    });
    const plan = JSON.parse(
      readFileSync(join(stageContext.paths.policy, 'plan.json'), 'utf8'),
    ) as DeploymentPlan;
    expect(plan.rules).toEqual([
      expect.objectContaining({ id: 'policy_skipped' }),
    ]);
  });

  it('runs only the policy file from the application source', async () => {
    const { sourcePath, context: stageContext } = context();
    const applicationPolicy = 'version: 1\n';
    mkdirSync(join(sourcePath, '.hibiscus'));
    writeFileSync(
      join(sourcePath, '.hibiscus/policy.yaml'),
      applicationPolicy,
      'utf8',
    );
    const planWithoutHash = {
      run_id: stageContext.deployment.id,
      app: stageContext.application.name,
      digest: stageContext.deployment.imageDigest,
      source_revision: stageContext.deployment.sourceRevision,
      decision: 'allow' as const,
      targets: ['onprem', 'cloud_run'],
      failover_allowed: true,
      rules: [],
    };
    const plan: DeploymentPlan = {
      ...planWithoutHash,
      plan_hash: createHash('sha256')
        .update(canonicalJson(planWithoutHash))
        .digest('hex'),
    };
    const run = vi.fn(async (_spec: { args: string[] }) => {
      writeFileSync(
        join(stageContext.paths.policy, 'plan.json'),
        JSON.stringify(plan),
        'utf8',
      );
      return {
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      };
    });
    const { policy } = stage(run);

    const outcome = await policy.run(stageContext);

    const args = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('--policy') + 1]).toBe(
      join(sourcePath, '.hibiscus/policy.yaml'),
    );
    expect(outcome.policyResult).toMatchObject({
      policyPath: '.hibiscus/policy.yaml',
      policyHash: createHash('sha256').update(applicationPolicy).digest('hex'),
      skipped: false,
    });
  });
});
