// ⑤ 승인이 필요한 앱: needs_approval → 사람이 승인 → 서명 → 배포 → activated
// 정책: 확신 없는 개인정보 후보가 있어 R3(human_review_pii) 가 걸린다. R3 는 배포 위치를 좁히지 않으므로
// targets 는 [onprem, cloud_run], failover_allowed 는 true (policy/README.md 의 R3 와 default 규칙).
// 상태 전이는 backend-v2 worker 순서를 흉내낸다: approve → running(sign) → sign succeeded(approval·sign_result·audit sign) →
// deploy running → deploy succeeded(deploy_result activated) → deployment succeeded, deploymentPerformed true.

import { ApiError } from '../api/client';
import { MOCK_USER } from '../api/mock';
import type { Approval, DecisionLogDeploy, PiiReport, Plan, SignLog, SignResult, TestResult } from '../api/contracts';
import type { Deployment, DeploymentView, RoutingTarget, StageExecution } from '../api/types';
import {
  AGENT_ID,
  AGENT_NAME,
  IMAGE_REPO,
  REQUESTER,
  agentStatus,
  applicationView,
  at,
  auditLog,
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
import { buildAllowDeployment, dep2Targets, servingAgent } from './scenario2-allow-activated';
import type { MockScenario } from './scenario';

export const DEP5_ID = 'dep-0005-guestbook-approval';
const DIGEST = 'sha256:7b3e9d1c4a6f082e5d7c9b1a3f5e7d9c2b4a6e8f0d1c3b5a7e9f1d3c5b7a9e1f';
const COMMIT = '4e7a1c9b3d5f2e8a0c6b4d2f9e1a7c3b5d8f0a2e';
const PLAN_HASH = '5a1c3e7f9b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a';
const CLOUD_REVISION = 'guestbook-d7b3e9d1c4a6f';
const CONTAINER = 'hibiscus-dep-0005-guestbook-approval-7b3e9d1c4a6f';
const ONPREM_PORT = 18083;
export const TARGET_ONPREM_V5 = 'tgt-onprem-v5-2e7c';
export const TARGET_CLOUDRUN_V5 = 'tgt-cloudrun-v5-8b1d';

/** 승인 뒤 단계 전환 시각 (ms). 테스트에서도 같은 값을 쓴다 */
export const APPROVAL_TIMELINE = { signStart: 1000, signDone: 3000, deployDone: 7000 } as const;

const testResult: TestResult = {
  run_id: DEP5_ID,
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
  run_id: DEP5_ID,
  app: 'guestbook',
  digest: DIGEST,
  source_revision: COMMIT,
  decision: 'needs_approval',
  targets: ['onprem', 'cloud_run'],
  failover_allowed: true,
  requires: [
    {
      id: 'human_review_pii',
      hint: '해당 칼럼이 개인정보인지 사람이 확인',
      hint_i18n: { ja: '該当カラムが個人情報かどうか人が確認' },
      rule_id: 'R3',
      allowed_targets: ['onprem', 'cloud_run'],
    },
  ],
  rules: [
    { id: 'R1', result: 'not_matched' },
    { id: 'R1b', result: 'not_matched' },
    { id: 'R1c', result: 'not_matched' },
    { id: 'R2', result: 'not_matched' },
    { id: 'R3', result: 'matched', reason: '확신 없는 개인정보 후보 있음 (posts.message)', reason_i18n: { ja: '確信のない個人情報候補あり（posts.message）' } },
    { id: 'R4', result: 'not_matched' },
    { id: 'R5', result: 'not_matched' },
    { id: 'R6', result: 'not_matched' },
    { id: 'R7', result: 'not_matched' },
    { id: 'default', result: 'matched', reason: '개인정보 없음, 테스트 통과: 하이브리드 배포 허용', reason_i18n: { ja: '個人情報なし、テスト合格：ハイブリッドデプロイを許可' } },
  ],
  plan_hash: PLAN_HASH,
};

const pii: PiiReport = {
  run_id: DEP5_ID,
  pii: [{ table: 'posts', column: 'message', kind: 'other', evidence: '자유 입력 텍스트에 연락처가 섞여 들어올 수 있음', confident: false, source: 'heuristic' }],
};

const decisionLine: DecisionLogDeploy = {
  kind: 'deploy',
  time: at(10800 + 95),
  run_id: DEP5_ID,
  digest: DIGEST,
  source_revision: COMMIT,
  decision: 'needs_approval',
  targets: ['onprem', 'cloud_run'],
  rule_ids: ['R3', 'default'],
  plan_hash: PLAN_HASH,
};

const explainKo = `# 배포 결정: guestbook (실행 ${DEP5_ID})

**승인 필요.** 사람이 확인한 뒤에만 온프레(사내) 및 Cloud Run에 배포합니다.

온프레가 멈추면 Cloud Run으로 트래픽을 넘깁니다.

재생 결과: none 20/20, restart 20/20, replace 20/20

## 이유

- 확신 없는 개인정보 후보 있음 (posts.message) (R3)

## 해결 조건

- 해당 칼럼이 개인정보인지 사람이 확인 → 해소되면 온프레(사내), Cloud Run

---

결정 지문 \`${PLAN_HASH.slice(0, 12)}\` · 이미지 \`${DIGEST.slice(0, 19)}\`
커밋 \`${COMMIT.slice(0, 7)}\`
`;

const explainJa = `# デプロイ判定：guestbook（実行${DEP5_ID}）

**承認が必要。**人が確認した後にのみオンプレ（社内）とCloud Runにデプロイします。

オンプレが停止した場合、Cloud Runにトラフィックを切り替えます。

再生結果：none 20/20、restart 20/20、replace 20/20

## 理由

- 確信のない個人情報候補あり（posts.message）（R3）

## 解決条件

- 該当カラムが個人情報かどうか人が確認→解消後はオンプレ（社内）、Cloud Run

---

判定ハッシュ\`${PLAN_HASH.slice(0, 12)}\`・イメージ\`${DIGEST.slice(0, 19)}\`
コミット\`${COMMIT.slice(0, 7)}\`
`;

interface ApprovalState {
  approvedAt: number | null;
  signStarted: boolean;
  signDone: boolean;
  deployDone: boolean;
}

export function buildScenario5(): MockScenario {
  const state: ApprovalState = { approvedAt: null, signStarted: false, signDone: false, deployDone: false };
  const previous = buildAllowDeployment();
  const { onprem: onpremV2, cloudRun: cloudRunV2 } = dep2Targets();
  const newTargets: { onprem: RoutingTarget; cloudRun: RoutingTarget } = {
    onprem: onpremTarget(TARGET_ONPREM_V5, DEP5_ID, ONPREM_PORT, 20003),
    cloudRun: cloudRunTarget(TARGET_CLOUDRUN_V5, DEP5_ID),
  };

  const dep: Deployment = deployment({
    id: DEP5_ID,
    version: 3,
    sourceRevision: COMMIT,
    imageDigest: DIGEST,
    status: 'awaiting_approval',
    decision: 'needs_approval',
    currentStage: 'sign',
    sourceRevisionVerified: true,
    createdAt: at(10800),
    updatedAt: at(10800 + 96),
  });

  const test = stage(DEP5_ID, { stage: 'test', status: 'succeeded', exitCode: 0, startedAt: at(10802), finishedAt: at(10890), summary: { stub: false, test_passed: true } });
  const policy = stage(DEP5_ID, { stage: 'policy', status: 'succeeded', exitCode: 2, startedAt: at(10891), finishedAt: at(10895), summary: { decision: 'needs_approval', targets: ['onprem', 'cloud_run'], failover_allowed: true, requires: plan.requires, mode: 'cli' } });

  const artifacts = [
    jsonArtifact(test, 'test_result', 'test/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'test_result', 'policy/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'plan', 'policy/plan.json', plan, 'contracts/Plan.schema.json'),
    jsonArtifact(policy, 'pii', 'policy/pii.json', pii, 'policy/contracts/PiiReport.schema.json'),
    textArtifact(policy, 'explain.ko', 'policy/explain.ko.md', explainKo),
    textArtifact(policy, 'explain.ja', 'policy/explain.ja.md', explainJa),
    textArtifact(policy, 'audit_log', 'logs/policy.jsonl', JSON.stringify(decisionLine) + '\n'),
  ];

  const current: DeploymentView = view(
    dep,
    [test, policy],
    policyResult(DEP5_ID, { decision: 'needs_approval', planHash: PLAN_HASH, targets: ['onprem', 'cloud_run'], failoverAllowed: true, requires: plan.requires ?? [] }, artifacts[2]!.id, artifacts[3]!.id, at(10895)),
    artifacts,
    [auditLog(policy, decisionLine)],
  );

  const iso = (ms: number) => new Date(ms).toISOString();

  const advance = (now: number) => {
    if (state.approvedAt === null) return;
    const elapsed = now - state.approvedAt;
    let signStage: StageExecution | undefined = current.stages.find((s) => s.stage === 'sign');

    if (elapsed >= APPROVAL_TIMELINE.signStart && !state.signStarted) {
      state.signStarted = true;
      signStage = stage(DEP5_ID, { stage: 'sign', status: 'running', startedAt: iso(state.approvedAt + APPROVAL_TIMELINE.signStart) });
      current.stages.push(signStage);
      dep.status = 'running';
      dep.currentStage = 'sign';
      dep.updatedAt = iso(now);
    }

    if (elapsed >= APPROVAL_TIMELINE.signDone && state.signStarted && !state.signDone && signStage) {
      state.signDone = true;
      const signedAt = iso(state.approvedAt + APPROVAL_TIMELINE.signDone);
      signStage.status = 'succeeded';
      signStage.exitCode = 0;
      signStage.finishedAt = signedAt;
      signStage.summary = { mode: 'cli', approver: MOCK_USER.id };
      const approval: Approval = { run_id: DEP5_ID, digest: DIGEST, plan_hash: PLAN_HASH, plan_sha256: 'c'.repeat(64), requester: REQUESTER, approver: MOCK_USER.id, approved_at: iso(state.approvedAt) };
      const signResult: SignResult = { run_id: DEP5_ID, digest: DIGEST, source_revision: COMMIT, plan_hash: PLAN_HASH, targets: ['onprem', 'cloud_run'], failover_allowed: true, requester: REQUESTER, approver: MOCK_USER.id, signature_ref: `cosign:${IMAGE_REPO}@${DIGEST}`, signed_at: signedAt };
      const signLine: SignLog = { kind: 'sign', time: signedAt, run_id: DEP5_ID, digest: DIGEST, source_revision: COMMIT, plan_hash: PLAN_HASH, result: 'signed', requester: REQUESTER, approver: MOCK_USER.id, reason: null, signature_ref: signResult.signature_ref };
      current.artifacts.push(
        jsonArtifact(signStage, 'approval', 'sign/approval.json', approval, 'signer/contracts/Approval.schema.json'),
        jsonArtifact(signStage, 'sign_result', 'sign/sign_result.json', signResult, 'contracts/SignResult.schema.json'),
        textArtifact(signStage, 'audit_log', 'logs/sign.jsonl', JSON.stringify(decisionLine) + '\n' + JSON.stringify(signLine) + '\n'),
      );
      current.auditLogs.push(auditLog(signStage, signLine));
      const deployStage = stage(DEP5_ID, { stage: 'deploy', status: 'running', startedAt: signedAt });
      current.stages.push(deployStage);
      dep.currentStage = 'deploy';
      dep.updatedAt = iso(now);
    }

    const deployStage = current.stages.find((s) => s.stage === 'deploy');
    if (elapsed >= APPROVAL_TIMELINE.deployDone && state.signDone && !state.deployDone && deployStage) {
      state.deployDone = true;
      const finishedAt = iso(state.approvedAt + APPROVAL_TIMELINE.deployDone);
      const result = deployResultActivated({
        runId: DEP5_ID,
        digest: DIGEST,
        cloudRevision: CLOUD_REVISION,
        onpremContainer: CONTAINER,
        onpremPort: ONPREM_PORT,
        routingTargetId: TARGET_ONPREM_V5,
        standbyTargetId: TARGET_CLOUDRUN_V5,
        startedAt: deployStage.startedAt,
        finishedAt,
      });
      result.routing.revision = 2;
      deployStage.status = 'succeeded';
      deployStage.exitCode = 0;
      deployStage.finishedAt = finishedAt;
      deployStage.summary = { decision: result.decision, image: result.image, targets: result.targets.map((s) => `${s.target}:${s.phase}:${s.result}`), routing: result.routing };
      current.artifacts.push(jsonArtifact(deployStage, 'deploy_result', 'deploy/deploy_result.json', result));
      dep.status = 'succeeded';
      dep.deploymentPerformed = true;
      dep.updatedAt = iso(now);
    }
  };

  const approve = (deploymentId: string, now: number): Deployment => {
    if (deploymentId !== DEP5_ID) {
      const other = previous.deployment.id === deploymentId ? previous.deployment : null;
      if (!other) throw new ApiError(404, 'Deployment not found');
      throw new ApiError(409, 'Deployment is not awaiting approval');
    }
    if (dep.status !== 'awaiting_approval') throw new ApiError(409, 'Deployment is not awaiting approval');
    if (dep.requester === MOCK_USER.id) throw new ApiError(403, 'Requester cannot approve their own deployment');
    state.approvedAt = now;
    dep.approver = MOCK_USER.id;
    dep.status = 'running';
    dep.currentStage = 'sign';
    dep.updatedAt = iso(now);
    return dep;
  };

  const frame = (): RoutingFrame => {
    if (!state.deployDone) {
      return {
        route: route(onpremV2, 1, { status: 'healthy', consecutiveSuccesses: 60 }),
        targets: [targetView(onpremV2, { status: 'healthy', consecutiveSuccesses: 60 }), targetView(cloudRunV2, { status: 'healthy', consecutiveSuccesses: 60 })],
        agents: { [AGENT_ID]: servingAgent() },
        caption: state.approvedAt === null ? 'v3 는 승인을 기다리는 중. v2 온프레가 서비스 중' : 'v3 승인됨. 서명·배포가 끝나면 route 가 v3 로 바뀜',
      };
    }
    return {
      route: route(newTargets.onprem, 2, { status: 'healthy', consecutiveSuccesses: 3 }),
      targets: [
        targetView(newTargets.onprem, { status: 'healthy', consecutiveSuccesses: 3 }),
        targetView(newTargets.cloudRun, { status: 'healthy', consecutiveSuccesses: 3 }),
        targetView(onpremV2, { status: 'healthy', consecutiveSuccesses: 70 }),
        targetView(cloudRunV2, { status: 'healthy', consecutiveSuccesses: 70 }),
      ],
      agents: { [AGENT_ID]: agentStatus({ status: 'online', serving: { run_id: DEP5_ID, digest: DIGEST, container: CONTAINER }, public_url: `http://127.0.0.1:${ONPREM_PORT}` }) },
      caption: 'v3 활성화. 온프레가 새 버전으로 트래픽을 받고 Cloud Run 은 standby',
    };
  };

  return {
    id: 5,
    title: '⑤ 승인 후 배포',
    description: '확신 없는 개인정보 후보 → 사람 승인 → 서명 → 배포 → activated',
    defaultPath: `/deployments/${DEP5_ID}`,
    application: applicationView(),
    deployments: [current, previous],
    frames: [frame],
    frameSeconds: 5,
    agentName: AGENT_NAME,
    controls: { advance, approve },
  };
}
