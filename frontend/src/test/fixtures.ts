// 테스트용 최소 fixture. 실제 API 응답 형태(src/api/types.ts)를 그대로 따른다.
import type { DeployResult } from '../api/contracts';
import type { Deployment, DeploymentArtifact, DeploymentView, PolicyResult, StageExecution } from '../api/types';

export const DIGEST = `sha256:${'a'.repeat(64)}`;
export const COMMIT = '0123456789abcdef0123456789abcdef01234567';

export function makeDeployment(patch: Partial<Deployment> = {}): Deployment {
  return {
    id: 'd1',
    applicationId: 'a1',
    version: 1,
    trigger: 'manual',
    sourceRevision: COMMIT,
    sourceRevisionVerified: false,
    imageDigest: DIGEST,
    digestSource: 'registry',
    requester: 'u1',
    approver: null,
    decision: 'allow',
    status: 'succeeded',
    currentStage: 'deploy',
    error: null,
    workDir: '',
    executionMode: 'cli',
    deploymentPerformed: true,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:10.000Z',
    ...patch,
  };
}

const SEQUENCE = { test: 1, policy: 2, sign: 3, deploy: 4 } as const;

export function makeStage(patch: Partial<StageExecution> & Pick<StageExecution, 'stage'>): StageExecution {
  return {
    id: `${patch.stage}-1`,
    deploymentId: 'd1',
    sequence: SEQUENCE[patch.stage],
    attempt: 1,
    status: 'succeeded',
    exitCode: 0,
    startedAt: '2026-10-03T00:00:00.000Z',
    finishedAt: '2026-10-03T00:00:01.000Z',
    artifacts: {},
    summary: null,
    error: null,
    ...patch,
  };
}

export function makeArtifact(stageId: string, name: string, value: unknown, patch: Partial<DeploymentArtifact> = {}): DeploymentArtifact {
  return {
    id: `${stageId}-${name}`,
    deploymentId: 'd1',
    stageExecutionId: stageId,
    name,
    relativePath: `${name}.json`,
    mediaType: 'application/json',
    content: typeof value === 'string' ? value : JSON.stringify(value),
    contentHash: 'x',
    schemaName: null,
    validationError: null,
    createdAt: '2026-10-03T00:00:01.000Z',
    ...patch,
  };
}

export function makePolicyResult(patch: Partial<PolicyResult> = {}): PolicyResult {
  return {
    deploymentId: 'd1',
    decision: 'allow',
    planHash: 'h'.repeat(64),
    targets: ['onprem', 'cloud_run'],
    failoverAllowed: true,
    requires: [],
    policyPath: '.hibiscus/policy.yaml',
    policyHash: 'p'.repeat(64),
    skipped: false,
    planPath: null,
    piiPath: null,
    planArtifactId: null,
    piiArtifactId: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...patch,
  };
}

export function makeDeployResult(patch: Partial<DeployResult> = {}): DeployResult {
  return {
    run_id: 'd1',
    digest: DIGEST,
    image: `repo@${DIGEST}`,
    decision: 'activated',
    signature: { verified: true, ref: `cosign:repo@${DIGEST}`, key: 'k' },
    targets_planned: ['cloud_run', 'onprem'],
    failover_allowed: true,
    targets: [],
    checks: [],
    routing: { result: 'ok', kind: 'onprem', revision: 1, target_id: 't1' },
    started_at: '2026-10-03T00:00:00.000Z',
    finished_at: '2026-10-03T00:00:05.000Z',
    ...patch,
  };
}

export function makeView(patch: Partial<DeploymentView> = {}): DeploymentView {
  return { deployment: makeDeployment(), stages: [], policyResult: null, artifacts: [], auditLogs: [], ...patch };
}

/** test → policy → sign 까지 성공한 기본 뷰. 산출물의 run_id·digest 는 deployment 와 같다. */
export function makeAllowView(options: { deployment?: Partial<Deployment>; deployStage?: StageExecution; deployResult?: DeployResult | null; testValidationError?: string } = {}): DeploymentView {
  const deployment = makeDeployment(options.deployment);
  const test = makeStage({ stage: 'test', summary: { stub: false, test_passed: true } });
  const policy = makeStage({ stage: 'policy' });
  const sign = makeStage({ stage: 'sign' });
  const stages = [test, policy, sign];
  if (options.deployStage) stages.push(options.deployStage);
  const testResult = { run_id: deployment.id, app: 'app', digest: deployment.imageDigest, source_revision: deployment.sourceRevision, passed: true, match: { total: 20, matched: 20 }, failures: [], facts: { db: 'postgres' } };
  const plan = { run_id: deployment.id, app: 'app', digest: deployment.imageDigest, source_revision: deployment.sourceRevision, decision: 'allow', targets: ['onprem', 'cloud_run'], failover_allowed: true, rules: [{ id: 'default', result: 'matched', reason: '허용' }], plan_hash: 'h'.repeat(64) };
  const signResult = { run_id: deployment.id, digest: deployment.imageDigest, source_revision: deployment.sourceRevision, plan_hash: 'h'.repeat(64), targets: ['onprem', 'cloud_run'], failover_allowed: true, requester: 'u1', approver: 'auto', signature_ref: `cosign:repo@${deployment.imageDigest}`, signed_at: '2026-10-03T00:00:03.000Z' };
  const artifacts = [
    makeArtifact(test.id, 'test_result', testResult, options.testValidationError ? { validationError: options.testValidationError } : {}),
    makeArtifact(policy.id, 'plan', plan),
    makeArtifact(sign.id, 'sign_result', signResult),
  ];
  if (options.deployStage && options.deployResult) artifacts.push(makeArtifact(options.deployStage.id, 'deploy_result', options.deployResult));
  return { deployment, stages, policyResult: makePolicyResult({ deploymentId: deployment.id }), artifacts, auditLogs: [] };
}
