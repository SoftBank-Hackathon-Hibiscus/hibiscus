/** 기본 구성으로 서비스를 조립한다. 테스트는 runner 나 store 를 바꿔 끼운다 */
import type { Config } from "../config.js";
import { type CommandRunner, RealCommandRunner } from "../infrastructure/command-runner.js";
import { MemoryStore } from "../infrastructure/store/memory.js";
import type { Store } from "../infrastructure/store/store.js";
import { StubApprovalProvider } from "../pipeline/approval/stub.js";
import { PipelineService } from "../pipeline/service.js";
import { DeployStage } from "../pipeline/stages/deploy.js";
import { PolicyStage } from "../pipeline/stages/policy.js";
import { SignStage } from "../pipeline/stages/sign.js";
import { TestStubStage } from "../pipeline/stages/test-stub.js";

export interface BuildOverrides {
  runner?: CommandRunner;
  store?: Store;
}

export function buildService(config: Config, overrides: BuildOverrides = {}): PipelineService {
  return new PipelineService({
    config,
    store: overrides.store ?? new MemoryStore(),
    runner: overrides.runner ?? new RealCommandRunner(),
    approvals: new StubApprovalProvider(config.signerMode),
    stages: {
      test: new TestStubStage(),
      policy: new PolicyStage(),
      sign: new SignStage(),
      deploy: new DeployStage(),
    },
  });
}
