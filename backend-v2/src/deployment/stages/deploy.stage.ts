import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type {
  StageContext,
  StageOutcome,
  StageRunner,
} from '../types/deployment.type.js';

@Injectable()
export class DeployStage implements StageRunner {
  readonly name = 'deploy' as const;

  constructor(private readonly config: ConfigService<BackendConfig, true>) {}

  async run(_context: StageContext): Promise<StageOutcome> {
    const mode = this.config.get('backend.deployMode', { infer: true });
    if (mode === 'off') {
      return {
        status: 'skipped',
        artifacts: {},
        summary: { mode, reason: '실제 배포 조율기를 호출하지 않음' },
        deploymentPatch: { deploymentPerformed: false },
      };
    }
    return {
      status: 'failed',
      artifacts: {},
      error: `Deployment orchestrator is not implemented for DEPLOY_MODE=${mode}`,
      deploymentPatch: { deploymentPerformed: false },
    };
  }
}
