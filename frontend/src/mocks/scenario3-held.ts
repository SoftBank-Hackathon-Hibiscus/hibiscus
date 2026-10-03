// ③ v3 후보 검사 실패 → held, 기존 v2 서비스 유지
// deploy_result 형식은 #26, held 의미는 deploy/coordinator (후보 check 실패 → discard 후 기존 유지).

import type { DeployResult, Plan, TestResult, SignResult, DecisionLogDeploy, SignLog, PiiReport } from '../api/contracts';
import {
  AGENT_ID,
  AGENT_NAME,
  CLOUD_RUN_URL,
  IMAGE_REPO,
  REQUESTER,
  at,
  applicationView,
  auditLog,
  deployment,
  jsonArtifact,
  policyResult,
  route,
  stage,
  targetView,
  textArtifact,
  view,
  type RoutingFrame,
} from './common';
import { buildAllowDeployment, dep2Targets, servingAgent } from './scenario2-allow-activated';
import type { MockScenario } from './scenario';

export const DEP3_ID = 'dep-0003-guestbook-held';
const DIGEST = 'sha256:c4d1e8b2a6f0937d5e1c2b3a4958677f0e1d2c3b4a5968778899aabbccddeeff';
const COMMIT = '9b2e5c8f1a4d7b0e3c6f9a2d5b8e1c4f7a0d3b6e';
const PLAN_HASH = '0b1d4f8c2e6a9d3b7f1c5e9a2d6b0f4c8e1a5d9b3f7c1e5a9d2b6f0c4e8a1d5b';
const CLOUD_REVISION = 'guestbook-dc4d1e8b2a6f0';
const CONTAINER = 'hibiscus-dep-0003-guestbook-held-c4d1e8b2a6f0';

const testResult: TestResult = {
  run_id: DEP3_ID,
  app: 'guestbook',
  digest: DIGEST,
  source_revision: COMMIT,
  passed: true,
  match: { total: 20, matched: 20 },
  failures: [],
  facts: {
    db: 'postgres',
    writes_local_file: [],
    conditions: [
      { name: 'none', total: 20, matched: 20, failed: false, mismatches: [] },
      { name: 'restart', total: 20, matched: 20, failed: false, mismatches: [] },
      { name: 'replace', total: 20, matched: 20, failed: false, mismatches: [] },
    ],
  },
};

const plan: Plan = {
  run_id: DEP3_ID,
  app: 'guestbook',
  digest: DIGEST,
  source_revision: COMMIT,
  decision: 'allow',
  targets: ['onprem', 'cloud_run'],
  failover_allowed: true,
  rules: [
    { id: 'R1', result: 'not_matched' },
    { id: 'R1b', result: 'not_matched' },
    { id: 'R1c', result: 'not_matched' },
    { id: 'R2', result: 'not_matched' },
    { id: 'R3', result: 'not_matched' },
    { id: 'R4', result: 'not_matched' },
    { id: 'R5', result: 'not_matched' },
    { id: 'R6', result: 'not_matched' },
    { id: 'R7', result: 'not_matched' },
    { id: 'default', result: 'matched', reason: '개인정보 없음, 테스트 통과: 하이브리드 배포 허용', reason_i18n: { ja: '個人情報なし、テスト合格：ハイブリッドデプロイを許可' } },
  ],
  plan_hash: PLAN_HASH,
};

const pii: PiiReport = { run_id: DEP3_ID, pii: [] };

const signResult: SignResult = {
  run_id: DEP3_ID,
  digest: DIGEST,
  source_revision: COMMIT,
  plan_hash: PLAN_HASH,
  targets: ['onprem', 'cloud_run'],
  failover_allowed: true,
  requester: REQUESTER,
  approver: 'auto',
  signature_ref: `cosign:${IMAGE_REPO}@${DIGEST}`,
  signed_at: at(7300),
};

const decisionLine: DecisionLogDeploy = {
  kind: 'deploy',
  time: at(7295),
  run_id: DEP3_ID,
  digest: DIGEST,
  source_revision: COMMIT,
  decision: 'allow',
  targets: ['onprem', 'cloud_run'],
  rule_ids: ['default'],
  plan_hash: PLAN_HASH,
};

const signLine: SignLog = {
  kind: 'sign',
  time: at(7300),
  run_id: DEP3_ID,
  digest: DIGEST,
  source_revision: COMMIT,
  plan_hash: PLAN_HASH,
  result: 'signed',
  requester: REQUESTER,
  approver: 'auto',
  reason: null,
  signature_ref: signResult.signature_ref,
};

const candidateUrl = CLOUD_RUN_URL.replace('https://', 'https://cand---');

const deployResult: DeployResult = {
  run_id: DEP3_ID,
  digest: DIGEST,
  image: `${IMAGE_REPO}@${DIGEST}`,
  decision: 'held',
  signature: { verified: true, ref: `cosign:${IMAGE_REPO}@${DIGEST}`, key: '/srv/hibiscus/signer/keys/cosign.pub', tlog: 'ignored' },
  targets_planned: ['onprem', 'cloud_run'],
  failover_allowed: true,
  targets: [
    { target: 'cloud_run', phase: 'candidate', result: 'ok', revision: CLOUD_REVISION, candidate_url: candidateUrl },
    { target: 'onprem', phase: 'candidate', result: 'ok', job_id: `${DEP3_ID}-candidate-01`, container: CONTAINER, candidate_url: 'http://127.0.0.1:18082' },
    { target: 'cloud_run', phase: 'discard', result: 'ok', revision: CLOUD_REVISION },
    { target: 'onprem', phase: 'discard', result: 'ok', job_id: `${DEP3_ID}-discard-01`, container: CONTAINER },
  ],
  checks: [
    {
      target: 'cloud_run',
      mode: 'candidate',
      pass: false,
      url: `${candidateUrl}/health`,
      checker: 'http-health',
      checks: [{ name: 'health', pass: false, status: 503, ms: 812, error: 'HTTP 503 Service Unavailable' }],
    },
    {
      target: 'onprem',
      mode: 'candidate',
      pass: true,
      url: 'http://127.0.0.1:18082',
      checker: 'onprem-agent',
      checks: [{ name: 'health', pass: true, ms: 41 }],
    },
  ],
  routing: { result: 'skipped' },
  started_at: at(7301),
  finished_at: at(7360),
  error: 'Candidate checks failed: cloud_run',
};

function buildHeldDeployment() {
  const dep = deployment({
    id: DEP3_ID,
    version: 3,
    sourceRevision: COMMIT,
    imageDigest: DIGEST,
    status: 'failed',
    decision: 'allow',
    currentStage: 'deploy',
    sourceRevisionVerified: true,
    deploymentPerformed: false,
    error: '[deploy] held: Candidate checks failed: cloud_run',
    createdAt: at(7200),
    updatedAt: at(7360),
  });

  const test = stage(DEP3_ID, { stage: 'test', status: 'succeeded', exitCode: 0, startedAt: at(7202), finishedAt: at(7290), summary: { stub: false, test_passed: true } });
  const policy = stage(DEP3_ID, { stage: 'policy', status: 'succeeded', exitCode: 0, startedAt: at(7291), finishedAt: at(7295), summary: { decision: 'allow', targets: ['onprem', 'cloud_run'], failover_allowed: true, requires: [], mode: 'cli' } });
  const sign = stage(DEP3_ID, { stage: 'sign', status: 'succeeded', exitCode: 0, startedAt: at(7296), finishedAt: at(7300), summary: { mode: 'cli', approver: 'auto' } });
  const deploy = stage(DEP3_ID, {
    stage: 'deploy',
    status: 'failed',
    exitCode: 3,
    startedAt: at(7301),
    finishedAt: at(7360),
    error: 'held: Candidate checks failed: cloud_run',
    summary: {
      decision: 'held',
      image: deployResult.image,
      targets: deployResult.targets.map((step) => `${step.target}:${step.phase}:${step.result}`),
      routing: deployResult.routing,
      error: deployResult.error,
    },
  });

  const artifacts = [
    jsonArtifact(test, 'test_result', 'test/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'test_result', 'policy/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'plan', 'policy/plan.json', plan, 'contracts/Plan.schema.json'),
    jsonArtifact(policy, 'pii', 'policy/pii.json', pii, 'policy/contracts/PiiReport.schema.json'),
    textArtifact(policy, 'audit_log', 'logs/policy.jsonl', JSON.stringify(decisionLine) + '\n'),
    jsonArtifact(sign, 'sign_result', 'sign/sign_result.json', signResult, 'contracts/SignResult.schema.json'),
    textArtifact(sign, 'audit_log', 'logs/sign.jsonl', JSON.stringify(decisionLine) + '\n' + JSON.stringify(signLine) + '\n'),
    jsonArtifact(deploy, 'deploy_result', 'deploy/deploy_result.json', deployResult),
  ];

  return view(
    dep,
    [test, policy, sign, deploy],
    policyResult(DEP3_ID, { decision: 'allow', planHash: PLAN_HASH, targets: ['onprem', 'cloud_run'], failoverAllowed: true, requires: [] }, artifacts[2]!.id, artifacts[3]!.id, at(7295)),
    artifacts,
    [auditLog(policy, decisionLine), auditLog(sign, signLine)],
  );
}

export function buildScenario3(): MockScenario {
  const { onprem, cloudRun } = dep2Targets();
  // v3 는 활성화 전에 멈췄으므로 target 이 만들어지지 않았다. route 는 v2 온프레 그대로.
  const frame = (): RoutingFrame => ({
    route: route(onprem, 1, { status: 'healthy', consecutiveSuccesses: 40 }),
    targets: [
      targetView(onprem, { status: 'healthy', consecutiveSuccesses: 40 }),
      targetView(cloudRun, { status: 'healthy', consecutiveSuccesses: 40 }),
    ],
    agents: { [AGENT_ID]: servingAgent() },
    caption: 'v3 후보가 보류되어 v2 온프레가 그대로 서비스 중',
  });
  return {
    id: 3,
    title: '③ 후보 실패 → 보류',
    description: 'v3 Cloud Run 후보 health 503 → held. 후보 폐기, v2 서비스 유지',
    defaultPath: `/deployments/${DEP3_ID}`,
    application: applicationView(),
    deployments: [buildHeldDeployment(), buildAllowDeployment()],
    frames: [frame],
    frameSeconds: 5,
    agentName: AGENT_NAME,
  };
}
