// ⑤ 승인이 필요한 앱: needs_approval → 사람이 승인 → 서명 → 배포 → activated (On-Prem 만)
// 정책(main policy/policy.yaml): 확신 없는 개인정보 후보가 있으면 R3 가 needs_approval + human_review_pii 를 내고,
// 개인정보 후보가 하나라도 있으면 R4 가 targets 를 [onprem] 으로 좁히고 failover_allowed 를 false 로 만든다. 둘은 동시에 걸린다.
// 사람이 승인해도 개인정보 제약은 사라지지 않는다: 서명·배포는 같은 plan 범위(onprem 만, failover 없음)에서만 진행한다.
// 상태 전이는 backend-v2 worker 순서를 흉내낸다: approve → running(sign) → sign succeeded(approval·sign_result·audit sign) →
// deploy running → deploy succeeded(deploy_result activated, onprem 만) → deployment succeeded, deploymentPerformed true.

import { ApiError } from '../api/client';
import { MOCK_USER } from '../api/mock';
import type { Approval, DecisionLogDeploy, DeployResult, PiiReport, Plan, SignLog, SignResult, TestResult } from '../api/contracts';
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
const CONTAINER = 'hibiscus-dep-0005-guestbook-approval-7b3e9d1c4a6f';
const ONPREM_PORT = 18083;
export const TARGET_ONPREM_V5 = 'tgt-onprem-v5-2e7c';

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
  // R4 가 같이 걸려 onprem 만, failover 없음. 사람 승인은 R3 의 해결 조건이지 R4 의 제약을 풀지 않는다
  targets: ['onprem'],
  failover_allowed: false,
  requires: [
    {
      id: 'human_review_pii',
      hint: '해당 칼럼이 개인정보인지 사람이 확인',
      hint_i18n: { ja: '該当カラムが個人情報かどうかを人が確認' },
      rule_id: 'R3',
      // R3 를 뺀 나머지 걸린 규칙(R4)으로 좁힌 결과
      allowed_targets: ['onprem'],
    },
  ],
  rules: [
    { id: 'R1', result: 'not_matched' },
    { id: 'R1b', result: 'not_matched' },
    { id: 'R1c', result: 'not_matched' },
    { id: 'R2', result: 'not_matched' },
    { id: 'R3', result: 'matched', reason: '확신 없는 개인정보 후보(posts.message, other): 자유 입력 텍스트에 연락처가 섞여 들어올 수 있음', reason_i18n: { ja: '確信のない個人情報候補（posts.message、other）：自由入力テキストに連絡先が混ざる可能性' } },
    { id: 'R4', result: 'matched', reason: '개인정보(message, other) 발견: 자유 입력 텍스트에 연락처가 섞여 들어올 수 있음', reason_i18n: { ja: '個人情報（message、other）を検出：自由入力テキストに連絡先が混ざる可能性' } },
    { id: 'R5', result: 'not_matched' },
    { id: 'R6', result: 'not_matched' },
    { id: 'R7', result: 'not_matched' },
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
  targets: ['onprem'],
  rule_ids: ['R3', 'R4'],
  plan_hash: PLAN_HASH,
};

const explainKo = `# 배포 결정: guestbook (실행 ${DEP5_ID})

**승인 필요.** 사람이 확인한 뒤에만 온프레(사내)에 배포합니다.

온프레가 멈춰도 Cloud Run으로 트래픽을 넘기지 않습니다.

재생 결과: none 20/20, restart 20/20, replace 20/20

## 이유

- 확신 없는 개인정보 후보(posts.message, other): 자유 입력 텍스트에 연락처가 섞여 들어올 수 있음 (R3)
- 개인정보(message, other) 발견: 자유 입력 텍스트에 연락처가 섞여 들어올 수 있음 (R4)

## 해결 조건

- 해당 칼럼이 개인정보인지 사람이 확인 → 해소되면 온프레(사내)

---

결정 지문 \`${PLAN_HASH.slice(0, 12)}\` · 이미지 \`${DIGEST.slice(0, 19)}\`
커밋 \`${COMMIT.slice(0, 7)}\`
`;

const explainJa = `# デプロイ判定：guestbook（実行${DEP5_ID}）

**承認が必要。**人が確認した後にのみオンプレ（社内）にデプロイします。

オンプレが停止してもCloud Runにトラフィックを切り替えません。

再生結果：none 20/20、restart 20/20、replace 20/20

## 理由

- 確信のない個人情報候補（posts.message、other）：自由入力テキストに連絡先が混ざる可能性（R3）
- 個人情報（message、other）を検出：自由入力テキストに連絡先が混ざる可能性（R4）

## 解決条件

- 該当カラムが個人情報かどうかを人が確認→解消後はオンプレ（社内）

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
  // 정책이 onprem 만 허용하므로 v3 의 target 은 On-Prem 하나뿐이다 (routing.service 도 정책 targets 밖의 target 생성을 거부한다)
  const newOnprem: RoutingTarget = onpremTarget(TARGET_ONPREM_V5, DEP5_ID, ONPREM_PORT, 20003);

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
  const policy = stage(DEP5_ID, { stage: 'policy', status: 'succeeded', exitCode: 2, startedAt: at(10891), finishedAt: at(10895), summary: { decision: 'needs_approval', targets: ['onprem'], failover_allowed: false, requires: plan.requires, mode: 'cli' } });

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
    policyResult(DEP5_ID, { decision: 'needs_approval', planHash: PLAN_HASH, targets: ['onprem'], failoverAllowed: false, requires: plan.requires ?? [] }, artifacts[2]!.id, artifacts[3]!.id, at(10895)),
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
      // 서명은 plan 의 범위를 그대로 담는다. 승인이 R4 의 제약을 풀지 않으므로 onprem 만, failover 없음
      const signResult: SignResult = { run_id: DEP5_ID, digest: DIGEST, source_revision: COMMIT, plan_hash: PLAN_HASH, targets: ['onprem'], failover_allowed: false, requester: REQUESTER, approver: MOCK_USER.id, signature_ref: `cosign:${IMAGE_REPO}@${DIGEST}`, signed_at: signedAt };
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
      // On-Prem 만 배포. Cloud Run 후보·standby 없음 (sign_result.targets 가 [onprem] 이므로 orchestrator 도 cloud_run 을 계획하지 않는다)
      const result: DeployResult = {
        run_id: DEP5_ID,
        digest: DIGEST,
        image: `${IMAGE_REPO}@${DIGEST}`,
        decision: 'activated',
        signature: { verified: true, ref: `cosign:${IMAGE_REPO}@${DIGEST}`, key: '/srv/hibiscus/signer/keys/cosign.pub', tlog: 'ignored' },
        targets_planned: ['onprem'],
        failover_allowed: false,
        targets: [
          { target: 'onprem', phase: 'candidate', result: 'ok', job_id: `${DEP5_ID}-candidate-01`, container: CONTAINER, candidate_url: `http://127.0.0.1:${ONPREM_PORT}` },
          { target: 'onprem', phase: 'activate', result: 'ok', job_id: `${DEP5_ID}-activate-01`, previous: 'hibiscus-dep-0002-guestbook-allow-59cfea73dda0', serving: CONTAINER },
        ],
        checks: [{ target: 'onprem', mode: 'candidate', pass: true, url: `http://127.0.0.1:${ONPREM_PORT}`, checker: 'onprem-agent', checks: [{ name: 'health', pass: true, ms: 36 }] }],
        routing: { result: 'ok', target_id: TARGET_ONPREM_V5, kind: 'onprem', revision: 2 },
        started_at: deployStage.startedAt,
        finished_at: finishedAt,
      };
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
    // v3 는 On-Prem 에만 올라간다. v2 의 Cloud Run target 은 다른 deployment 라 failover 대상이 아니다 (같은 deployment 의 cloud_run 만 전환 후보)
    return {
      route: route(newOnprem, 2, { status: 'healthy', consecutiveSuccesses: 3 }),
      targets: [
        targetView(newOnprem, { status: 'healthy', consecutiveSuccesses: 3 }),
        targetView(onpremV2, { status: 'healthy', consecutiveSuccesses: 70 }),
        targetView(cloudRunV2, { status: 'healthy', consecutiveSuccesses: 70 }),
      ],
      agents: { [AGENT_ID]: agentStatus({ status: 'online', serving: { run_id: DEP5_ID, digest: DIGEST, container: CONTAINER }, public_url: `http://127.0.0.1:${ONPREM_PORT}` }) },
      caption: 'v3 활성화. 온프레만 새 버전으로 트래픽을 받고, 개인정보 제약으로 Cloud Run 대기·자동 전환은 없음',
    };
  };

  return {
    id: 5,
    title: '⑤ 승인 후 배포',
    description: '확신 없는 개인정보 후보 → 사람 승인 → 서명 → On-Prem 에만 배포 (Cloud Run·failover 없음)',
    defaultPath: `/deployments/${DEP5_ID}`,
    application: applicationView(),
    deployments: [current, previous],
    frames: [frame],
    frameSeconds: 5,
    agentName: AGENT_NAME,
    controls: { advance, approve },
  };
}
