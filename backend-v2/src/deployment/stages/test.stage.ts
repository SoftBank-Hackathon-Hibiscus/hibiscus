import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import { ParityTestStage } from './parity-test.stage.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  StageContext,
  StageOutcome,
  StageRunner,
} from '../types/deployment.type.js';
import { ApplicationPolicyInputService } from '../application-policy-input.service.js';

@Injectable()
export class TestStage implements StageRunner {
  readonly name = 'test' as const;

  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly parity: ParityTestStage,
    private readonly policyInput: ApplicationPolicyInputService,
  ) {}

  async run(context: StageContext): Promise<StageOutcome> {
    if (
      this.config.get('backend.parityTestMode', { infer: true }) === 'registry'
    ) {
      if (context.deployment.executionMode !== 'cli') {
        return {
          status: 'failed',
          artifacts: {},
          error: 'Registry parity requires STAGE_MODE=cli',
        };
      }
      return this.parity.run(context);
    }
    const { application, deployment, paths } = context;
    const templatePath = resolve(
      process.cwd(),
      'fixtures/test-templates',
      `${application.testTemplate}.json`,
    );
    try {
      const template = JSON.parse(readFileSync(templatePath, 'utf8')) as object;
      const result = {
        ...template,
        run_id: deployment.id,
        app: application.name,
        digest: deployment.imageDigest,
        source_revision: deployment.sourceRevision,
      };
      const output = resolve(paths.test, 'test_result.json');
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      const policyInput = this.policyInput.capture(
        application.sourcePath,
        paths,
      );
      return {
        status: 'succeeded',
        exitCode: 0,
        artifacts: {
          test_result: paths.relative(output),
          ...(policyInput ? { policy_input: policyInput } : {}),
        },
        summary: {
          template: application.testTemplate,
          stub: true,
          policy_input: Boolean(policyInput),
        },
      };
    } catch (error) {
      return {
        status: 'failed',
        artifacts: {},
        error: 'Failed to generate test result',
        summary: {
          details: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
