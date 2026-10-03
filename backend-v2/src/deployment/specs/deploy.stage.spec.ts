import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { ApplicationRepository } from '../../application/application.repository.js';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { DeployConfig } from '../../config/configs/deploy.config.js';
import { CommandRunner } from '../../infrastructure/command-runner.js';
import { DeployStage } from '../stages/deploy.stage.js';
import { DeploymentRepository } from '../deployment.repository.js';
import type { StageContext } from '../types/deployment.type.js';

describe('DeployStage source identity gate', () => {
  it('rejects unverified source before reading artifacts or contacting a target', async () => {
    const config = {
      get: () => 'real',
    } as unknown as ConfigService<BackendConfig & DeployConfig, true>;
    const run = vi.fn();
    const getView = vi.fn();
    const get = vi.fn();
    const stage = new DeployStage(
      config,
      { run } as unknown as CommandRunner,
      { getView } as unknown as ApplicationRepository,
      { environment: vi.fn() } as unknown as DeploymentRepository,
      { get } as unknown as ModuleRef,
    );
    const result = await stage.run({
      deployment: { sourceRevisionVerified: false, digestSource: 'registry' },
    } as StageContext);
    expect(result).toMatchObject({
      status: 'failed',
      error: 'Real deploy requires a verified source revision',
      deploymentPatch: { deploymentPerformed: false },
    });
    expect(run).not.toHaveBeenCalled();
    expect(getView).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
