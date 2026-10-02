import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { Application, Deployment } from '../../database/schema.js';
import { CommandRunner } from '../../infrastructure/command-runner.js';
import { SignStage } from '../stages/sign.stage.js';
import { DeploymentPaths } from '../types/deployment.type.js';

describe('SignStage', () => {
  it('rejects real signing before running a command when source is unverified', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hibiscus-sign-stage-'));
    try {
      const config = {
        get: (key: string) => {
          if (key === 'backend.signerMode') return 'real';
          throw new Error(`Unexpected config key: ${key}`);
        },
      } as unknown as ConfigService<BackendConfig, true>;
      const run = vi.fn();
      const runner = { run } as unknown as CommandRunner;
      const stage = new SignStage(config, runner);
      const paths = new DeploymentPaths(directory, 'deployment-1');
      paths.ensure();

      const result = await stage.run({
        application: {} as Application,
        deployment: {
          executionMode: 'cli',
          decision: 'allow',
          sourceRevisionVerified: false,
          digestSource: 'registry',
        } as Deployment,
        paths,
      });

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
});
