// ② binding 수정 후 allow → 배포 activated, 온프레 primary / Cloud Run standby
// 출처: backend/.work 의 방명록 allow 실행(plan·sign_result·decisions.jsonl·explain), parity/examples 의
//       premortem binding fixture 스토리(127.0.0.1 → 0.0.0.0), #26 deploy_result 형식.

import type { Plan, TestResult, PiiReport, SignResult, DecisionLogDeploy, SignLog } from '../api/contracts';
import {
  AGENT_ID,
  AGENT_NAME,
  IMAGE_REPO,
  REQUESTER,
  at,
  applicationView,
  auditLog,
  agentStatus,
  cloudRunTarget,
  deployResultActivated,
  deployment,
  jsonArtifact,
  onpremTarget,
  policyResult,
  route,
  stage,
  targetView,
  textArtifact,
  view,
  type RoutingFrame,
} from './common';
import type { MockScenario } from './scenario';
import type { DeploymentView, RoutingTarget } from '../api/types';

export const DEP2_ID = 'dep-0002-guestbook-allow';
export const DEP2_DIGEST = 'sha256:59cfea73dda0ffc3eefd0489c8e6f80d2ff93de2b96722ff662bf3289eb442ce';
export const DEP2_COMMIT = '1f6947dce692de48ef4580b1a3f5366adf66f5ae';
const PLAN_HASH = '74e9a08b690adf4c81e36dfd56347ce7f75719dddcc1803bb04aa90d2f894571';
export const DEP2_CLOUD_REVISION = 'guestbook-d59cfea73dda0';
export const DEP2_CONTAINER = 'hibiscus-dep-0002-guestbook-allow-59cfea73dda0';
export const DEP2_ONPREM_PORT = 18081;

export const TARGET_ONPREM_V2 = 'tgt-onprem-v2-9a1e';
export const TARGET_CLOUDRUN_V2 = 'tgt-cloudrun-v2-5c3f';

export function dep2Targets(): { onprem: RoutingTarget; cloudRun: RoutingTarget } {
  return {
    onprem: onpremTarget(TARGET_ONPREM_V2, DEP2_ID, DEP2_ONPREM_PORT, 20001),
    cloudRun: cloudRunTarget(TARGET_CLOUDRUN_V2, DEP2_ID),
  };
}

const testResult: TestResult = {
  run_id: DEP2_ID,
  app: 'guestbook',
  digest: DEP2_DIGEST,
  source_revision: DEP2_COMMIT,
  passed: true,
  match: { total: 20, matched: 20 },
  failures: [],
  facts: {
    db: 'postgres',
    writes_local_file: [],
    migration: { destructive: false, backward_compatible: true, findings: [] },
    conditions: [
      { name: 'none', total: 20, matched: 20, failed: false, mismatches: [] },
      { name: 'restart', total: 20, matched: 20, failed: false, mismatches: [] },
      { name: 'replace', total: 20, matched: 20, failed: false, mismatches: [] },
    ],
  },
};

const plan: Plan = {
  run_id: DEP2_ID,
  app: 'guestbook',
  digest: DEP2_DIGEST,
  source_revision: DEP2_COMMIT,
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

const pii: PiiReport = { run_id: DEP2_ID, pii: [] };

const explainKo = `# 배포 결정: guestbook (실행 ${DEP2_ID})

**배포 허용.** 이 이미지를 온프레(사내) 및 Cloud Run에 배포합니다.

온프레가 멈추면 Cloud Run으로 트래픽을 넘깁니다.

재생 결과: none 20/20, restart 20/20, replace 20/20

## 이유

- 기본 정책을 적용했습니다: 개인정보 없음, 테스트 통과: 하이브리드 배포 허용

## 해결 조건

- 해결할 것이 없습니다.

---

결정 지문 \`${PLAN_HASH.slice(0, 12)}\` · 이미지 \`${DEP2_DIGEST.slice(0, 19)}\`
커밋 \`${DEP2_COMMIT.slice(0, 7)}\`
`;

const explainJa = `# デプロイ判定：guestbook（実行${DEP2_ID}）

**デプロイ可。**このイメージをオンプレ（社内）とCloud Runにデプロイします。

オンプレが停止した場合、Cloud Runにトラフィックを切り替えます。

再生結果：none 20/20、restart 20/20、replace 20/20

## 理由

- 既定ポリシーを適用しました：個人情報なし、テスト合格：ハイブリッドデプロイを許可

## 解決条件

- 対応が必要な事項はありません。

---

判定ハッシュ\`${PLAN_HASH.slice(0, 12)}\`・イメージ\`${DEP2_DIGEST.slice(0, 19)}\`
コミット\`${DEP2_COMMIT.slice(0, 7)}\`
`;

const signResult: SignResult = {
  run_id: DEP2_ID,
  digest: DEP2_DIGEST,
  source_revision: DEP2_COMMIT,
  plan_hash: PLAN_HASH,
  targets: ['onprem', 'cloud_run'],
  failover_allowed: true,
  requester: REQUESTER,
  approver: 'auto',
  signature_ref: `cosign:${IMAGE_REPO}@${DEP2_DIGEST}`,
  signed_at: at(3700),
};

const decisionLine: DecisionLogDeploy = {
  kind: 'deploy',
  time: at(3695),
  run_id: DEP2_ID,
  digest: DEP2_DIGEST,
  source_revision: DEP2_COMMIT,
  decision: 'allow',
  targets: ['onprem', 'cloud_run'],
  rule_ids: ['default'],
  plan_hash: PLAN_HASH,
};

const signLine: SignLog = {
  kind: 'sign',
  time: at(3700),
  run_id: DEP2_ID,
  digest: DEP2_DIGEST,
  source_revision: DEP2_COMMIT,
  plan_hash: PLAN_HASH,
  result: 'signed',
  requester: REQUESTER,
  approver: 'auto',
  reason: null,
  signature_ref: signResult.signature_ref,
};

/** 시나리오 ②·③·④가 함께 쓰는 "v2 allow → activated" 배포 */
export function buildAllowDeployment(): DeploymentView {
  const dep = deployment({
    id: DEP2_ID,
    version: 2,
    sourceRevision: DEP2_COMMIT,
    imageDigest: DEP2_DIGEST,
    status: 'succeeded',
    decision: 'allow',
    currentStage: 'deploy',
    sourceRevisionVerified: true,
    deploymentPerformed: true,
    createdAt: at(3600),
    updatedAt: at(3790),
  });

  const test = stage(DEP2_ID, { stage: 'test', status: 'succeeded', exitCode: 0, startedAt: at(3602), finishedAt: at(3690), summary: { stub: false, test_passed: true } });
  const policy = stage(DEP2_ID, { stage: 'policy', status: 'succeeded', exitCode: 0, startedAt: at(3691), finishedAt: at(3695), summary: { decision: 'allow', targets: ['onprem', 'cloud_run'], failover_allowed: true, requires: [], mode: 'cli' } });
  const sign = stage(DEP2_ID, { stage: 'sign', status: 'succeeded', exitCode: 0, startedAt: at(3696), finishedAt: at(3700), summary: { mode: 'cli', approver: 'auto' } });
  const deploy = stage(DEP2_ID, { stage: 'deploy', status: 'succeeded', exitCode: 0, startedAt: at(3701), finishedAt: at(3790) });

  const deployResult = deployResultActivated({
    runId: DEP2_ID,
    digest: DEP2_DIGEST,
    cloudRevision: DEP2_CLOUD_REVISION,
    onpremContainer: DEP2_CONTAINER,
    onpremPort: DEP2_ONPREM_PORT,
    routingTargetId: TARGET_ONPREM_V2,
    standbyTargetId: TARGET_CLOUDRUN_V2,
    startedAt: at(3701),
    finishedAt: at(3790),
  });
  deploy.summary = {
    decision: deployResult.decision,
    image: deployResult.image,
    targets: deployResult.targets.map((step) => `${step.target}:${step.phase}:${step.result}`),
    routing: deployResult.routing,
  };

  const artifacts = [
    jsonArtifact(test, 'test_result', 'test/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'test_result', 'policy/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'plan', 'policy/plan.json', plan, 'contracts/Plan.schema.json'),
    jsonArtifact(policy, 'pii', 'policy/pii.json', pii, 'policy/contracts/PiiReport.schema.json'),
    jsonArtifact(policy, 'migration', 'policy/migration.json', testResult.facts?.migration),
    textArtifact(policy, 'explain.ko', 'policy/explain.ko.md', explainKo),
    textArtifact(policy, 'explain.ja', 'policy/explain.ja.md', explainJa),
    textArtifact(policy, 'audit_log', 'logs/policy.jsonl', JSON.stringify(decisionLine) + '\n'),
    jsonArtifact(sign, 'sign_result', 'sign/sign_result.json', signResult, 'contracts/SignResult.schema.json'),
    textArtifact(sign, 'audit_log', 'logs/sign.jsonl', JSON.stringify(decisionLine) + '\n' + JSON.stringify(signLine) + '\n'),
    jsonArtifact(deploy, 'deploy_result', 'deploy/deploy_result.json', deployResult),
  ];
  const planArtifact = artifacts[2]!;
  const piiArtifact = artifacts[3]!;

  return view(
    dep,
    [test, policy, sign, deploy],
    policyResult(DEP2_ID, { decision: 'allow', planHash: PLAN_HASH, targets: ['onprem', 'cloud_run'], failoverAllowed: true, requires: [] }, planArtifact.id, piiArtifact.id, at(3695)),
    artifacts,
    [auditLog(policy, decisionLine), auditLog(sign, signLine)],
  );
}

export function servingAgent() {
  return agentStatus({
    status: 'online',
    serving: { run_id: DEP2_ID, digest: DEP2_DIGEST, container: DEP2_CONTAINER },
    public_url: 'http://127.0.0.1:18081',
  });
}

export function buildScenario2(): MockScenario {
  const { onprem, cloudRun } = dep2Targets();
  const frame = (): RoutingFrame => ({
    route: route(onprem, 1, { status: 'healthy', consecutiveSuccesses: 12 }),
    targets: [
      targetView(onprem, { status: 'healthy', consecutiveSuccesses: 12 }),
      targetView(cloudRun, { status: 'healthy', consecutiveSuccesses: 12 }),
    ],
    agents: { [AGENT_ID]: servingAgent() },
    caption: 'v2 활성화 직후. 온프레가 트래픽을 받고 Cloud Run 은 standby',
  });
  return {
    id: 2,
    title: '② 허용 → 배포 완료',
    description: 'binding 수정 뒤 allow. 온프레 primary, Cloud Run standby 로 activated',
    defaultPath: `/deployments/${DEP2_ID}`,
    application: applicationView(),
    deployments: [buildAllowDeployment()],
    frames: [frame],
    frameSeconds: 5,
    agentName: AGENT_NAME,
  };
}
