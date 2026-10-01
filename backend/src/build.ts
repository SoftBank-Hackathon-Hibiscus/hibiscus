/** 기본 구성으로 서비스를 조립한다. 테스트는 runner 나 store 를 바꿔 끼운다 */
import { StubApprovalProvider } from "./approval/stub.js";
import { type CommandRunner, RealCommandRunner } from "./command-runner.js";
import type { Config } from "./config.js";
import { PipelineService } from "./pipeline.js";
import { DeployStage } from "./stages/deploy.js";
import { PolicyStage } from "./stages/policy.js";
import { SignStage } from "./stages/sign.js";
import { TestStubStage } from "./stages/test-stub.js";
import { MemoryStore } from "./store/memory.js";
import type { Store } from "./store/store.js";

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
