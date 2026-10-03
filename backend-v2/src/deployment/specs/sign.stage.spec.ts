import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { Application, Deployment } from '../../database/schema.js';
import {
  CommandRunner,
  type CommandSpec,
} from '../../infrastructure/command-runner.js';
import { SignStage } from '../stages/sign.stage.js';
import { TestStage } from '../stages/test.stage.js';
import { ParityTestStage } from '../stages/parity-test.stage.js';
import { DeploymentPaths } from '../types/deployment.type.js';

describe('SignStage', () => {
  it('rejects real signing after fixture tests without invoking the signer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hibiscus-sign-stage-'));
    try {
      const config = {
        get: (key: string) => {
          if (key === 'backend.signerMode') return 'real';
          if (key === 'backend.parityTestMode') return 'fixture';
          throw new Error(`Unexpected config key: ${key}`);
        },
      } as unknown as ConfigService<BackendConfig, true>;
      const run = vi.fn();
      const runner = { run } as unknown as CommandRunner;
      const stage = new SignStage(config, runner);
      const paths = new DeploymentPaths(directory, 'deployment-1');
      paths.ensure();

      const context = {
        application: { testTemplate: 'allow' } as Application,
        deployment: {
          executionMode: 'cli',
          decision: 'allow',
          sourceRevisionVerified: false,
          digestSource: 'registry',
        } as Deployment,
        paths,
      };
      const parityRun = vi.fn();
      const test = await new TestStage(config, {
        run: parityRun,
      } as unknown as ParityTestStage).run(context);
      expect(test.status).toBe('succeeded');
      expect(test.summary).toMatchObject({ stub: true });
      expect(test.deploymentPatch).toBeUndefined();
      expect(parityRun).not.toHaveBeenCalled();
      const result = await stage.run(context);

      expect(result).toMatchObject({
        status: 'failed',
        error: 'Real signing requires a verified source revision',
      });
      expect(run).not.toHaveBeenCalled();
      paths.cleanup();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('invokes the real signer for a verified registry image and checks its result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hibiscus-sign-verified-'));
    const paths = new DeploymentPaths(directory, 'verified-run');
    paths.ensure();
    try {
      const deployment = {
        id: 'verified-run',
        executionMode: 'cli',
        decision: 'allow',
        sourceRevisionVerified: true,
        digestSource: 'registry',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        sourceRevision: 'b'.repeat(40),
        requester: 'requester',
      } as Deployment;
      const plan = {
        run_id: deployment.id,
        digest: deployment.imageDigest,
        source_revision: deployment.sourceRevision,
        plan_hash: 'c'.repeat(64),
        targets: ['cloud_run'],
        failover_allowed: true,
      };
      writeFileSync(join(paths.policy, 'plan.json'), JSON.stringify(plan));
      const config = {
        get: (key: string) =>
          ({
            'backend.signerMode': 'real',
            'backend.repoRoot': directory,
            'backend.npmCommand': 'npm',
            'backend.signerTimeoutMs': 1000,
          })[key],
      } as ConfigService<BackendConfig, true>;
      const run = vi.fn().mockImplementation((spec: CommandSpec) => {
        expect(spec.args).not.toContain('--dry-run');
        writeFileSync(
          join(paths.sign, 'sign_result.json'),
          JSON.stringify({
            ...plan,
            requester: deployment.requester,
            approver: 'auto',
            signature_ref: `cosign:registry.example/app@${deployment.imageDigest}`,
          }),
        );
        return Promise.resolve({
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        });
      });
      const result = await new SignStage(config, { run }).run({
        application: { imageRepo: 'registry.example/app' } as Application,
        deployment,
        paths,
      });
      expect(result.status).toBe('succeeded');
      expect(run).toHaveBeenCalledOnce();
    } finally {
      paths.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
