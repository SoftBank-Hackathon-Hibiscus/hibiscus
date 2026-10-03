// ① 방명록 block + requires (fix_restart_failure, managed_db, object_storage)
// 출처: parity/result3.json (none 20/20, restart 14/20, replace 13/20), policy/policy.yaml 의 R1b·R5·R6 문구,
//       signer/fixtures/plans/block.plan.json 의 형식. 정책 설명은 policy/README.md 의 예시 형식.

import type { Plan, TestResult, PiiReport, DecisionLogDeploy } from '../api/contracts';
import { AGENT_ID, AGENT_NAME, at, applicationView, auditLog, deployment, jsonArtifact, policyResult, stage, textArtifact, view, type RoutingFrame } from './common';
import { agentStatus } from './common';
import type { MockScenario } from './scenario';

export const DEP1_ID = 'dep-0001-guestbook-block';
const DIGEST = 'sha256:3f9a0c1e5b7d2846a9c0e1f2b3d4c5a6978e0f1a2b3c4d5e6f708192a3b4c5d6';
const COMMIT = '83aea2d1f0c4b7e9a2d5f8c1b4e7a0d3c6f9b2e5';
const PLAN_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const restartMismatches = [
  { index: 11, request: 'GET /me' },
  { index: 12, request: 'POST /posts' },
  { index: 13, request: 'GET /posts' },
  { index: 14, request: 'GET /posts/2' },
  { index: 17, request: 'GET /me' },
  { index: 20, request: 'GET /posts' },
];
const replaceMismatches = [
  { index: 11, request: 'GET /me' },
  { index: 12, request: 'POST /posts', related_fact: '/app/data/data.db', related_storage: 'container_layer', related_kind: 'sqlite' },
  { index: 13, request: 'GET /posts', related_fact: '/app/data/data.db', related_storage: 'container_layer', related_kind: 'sqlite' },
  { index: 14, request: 'GET /posts/2', related_fact: '/app/data/data.db', related_storage: 'container_layer', related_kind: 'sqlite' },
  { index: 16, request: 'GET /uploads', related_fact: '/app/uploads', related_storage: 'container_layer', related_kind: 'local_upload' },
  { index: 17, request: 'GET /me' },
  { index: 20, request: 'GET /posts', related_fact: '/app/data/data.db', related_storage: 'container_layer', related_kind: 'sqlite' },
];

const testResult: TestResult = {
  run_id: DEP1_ID,
  app: 'guestbook',
  digest: DIGEST,
  source_revision: COMMIT,
  passed: false,
  match: { total: 20, matched: 20 },
  failures: [],
  facts: {
    db: 'sqlite',
    writes_local_file: ['/app/data/data.db', '/app/uploads'],
    storage: [
      { kind: 'sqlite', path: '/app/data/data.db', storage: 'container_layer' },
      { kind: 'local_upload', path: '/app/uploads', storage: 'container_layer' },
    ],
    conditions: [
      { name: 'none', total: 20, matched: 20, failed: false, mismatches: [] },
      { name: 'restart', total: 20, matched: 14, failed: true, mismatches: restartMismatches },
      { name: 'replace', total: 20, matched: 13, failed: true, mismatches: replaceMismatches },
    ],
  },
};

const plan: Plan = {
  run_id: DEP1_ID,
  app: 'guestbook',
  digest: DIGEST,
  source_revision: COMMIT,
  decision: 'block',
  targets: [],
  failover_allowed: false,
  requires: [
    {
      id: 'fix_restart_failure',
      hint: '재시작 후 상태·초기화 동작을 수정 (예: 시작할 때 데이터 삭제, 메모리에만 두는 세션)',
      hint_i18n: { ja: '再起動後の状態・初期化動作を修正（例：起動時のデータ削除、メモリのみのセッション）' },
      rule_id: 'R1b',
      allowed_targets: ['onprem'],
    },
    {
      id: 'managed_db',
      hint: 'SQLite를 PostgreSQL로 전환',
      hint_i18n: { ja: 'SQLiteをPostgreSQLへ移行' },
      rule_id: 'R5',
      allowed_targets: ['onprem'],
    },
    {
      id: 'object_storage',
      hint: '로컬 폴더에 쓰는 파일을 오브젝트 스토리지로 이전',
      hint_i18n: { ja: 'ローカルフォルダに書き込むファイルをオブジェクトストレージへ移行' },
      rule_id: 'R6',
      allowed_targets: ['onprem'],
    },
  ],
  rules: [
    { id: 'R1', result: 'not_matched' },
    { id: 'R1b', result: 'matched', reason: '재시작 후 불일치 (14/20 일치)', reason_i18n: { ja: '再起動後に不一致（14/20一致）' } },
    { id: 'R1c', result: 'not_matched' },
    { id: 'R2', result: 'not_matched' },
    { id: 'R3', result: 'not_matched' },
    { id: 'R4', result: 'not_matched' },
    { id: 'R5', result: 'matched_after_block', reason: 'SQLite 사용 (sqlite): 관리형 DB로 전환하기 전까지 클라우드 배포 제외', reason_i18n: { ja: 'SQLiteを使用（sqlite）：マネージドDBへ移行するまでクラウドデプロイを除外' } },
    { id: 'R6', result: 'matched_after_block', reason: '로컬 파일 쓰기: /app/uploads', reason_i18n: { ja: 'ローカルファイルへの書き込み：/app/uploads' } },
    { id: 'R7', result: 'not_matched' },
  ],
  plan_hash: PLAN_HASH,
};

const pii: PiiReport = { run_id: DEP1_ID, pii: [] };

const explainKo = `# 배포 결정: guestbook (실행 ${DEP1_ID})

**배포 차단.** 이 이미지는 배포하지 않습니다.

재생 결과: none 20/20, restart 14/20, replace 13/20

## 이유

- 재시작 후 불일치 (14/20 일치) (R1b)

차단 뒤에 함께 걸린 규칙:

- SQLite 사용 (sqlite): 관리형 DB로 전환하기 전까지 클라우드 배포 제외 (R5)
- 로컬 파일 쓰기: /app/uploads (R6)

## 해결 조건

- 재시작 후 상태·초기화 동작을 수정 (예: 시작할 때 데이터 삭제, 메모리에만 두는 세션) → 해소되면 온프레(사내)
- SQLite를 PostgreSQL로 전환 → 해소되면 온프레(사내)
- 로컬 폴더에 쓰는 파일을 오브젝트 스토리지로 이전 → 해소되면 온프레(사내)

---

결정 지문 \`${PLAN_HASH.slice(0, 12)}\` · 이미지 \`${DIGEST.slice(0, 19)}\`
커밋 \`${COMMIT.slice(0, 7)}\`
`;

const explainJa = `# デプロイ判定：guestbook（実行${DEP1_ID}）

**デプロイ不可。**このイメージはデプロイしません。

再生結果：none 20/20、restart 14/20、replace 13/20

## 理由

- 再起動後に不一致（14/20一致）（R1b）

ブロック後に併せて該当したルール：

- SQLiteを使用（sqlite）：マネージドDBへ移行するまでクラウドデプロイを除外（R5）
- ローカルファイルへの書き込み：/app/uploads（R6）

## 解決条件

- 再起動後の状態・初期化動作を修正（例：起動時のデータ削除、メモリのみのセッション）→解消後はオンプレ（社内）
- SQLiteをPostgreSQLへ移行→解消後はオンプレ（社内）
- ローカルフォルダに書き込むファイルをオブジェクトストレージへ移行→解消後はオンプレ（社内）

---

判定ハッシュ\`${PLAN_HASH.slice(0, 12)}\`・イメージ\`${DIGEST.slice(0, 19)}\`
コミット\`${COMMIT.slice(0, 7)}\`
`;

const decisionLine: DecisionLogDeploy = {
  kind: 'deploy',
  time: at(95),
  run_id: DEP1_ID,
  digest: DIGEST,
  source_revision: COMMIT,
  decision: 'block',
  targets: [],
  rule_ids: ['R1b', 'R5', 'R6'],
  plan_hash: PLAN_HASH,
};

export function buildScenario1(): MockScenario {
  const dep = deployment({
    id: DEP1_ID,
    version: 1,
    sourceRevision: COMMIT,
    imageDigest: DIGEST,
    status: 'blocked',
    decision: 'block',
    currentStage: 'policy',
    // registry parity 검증은 끝났으므로 true. 테스트가 block이어도 true일 수 있다 (#29).
    sourceRevisionVerified: true,
    executionMode: 'cli',
    createdAt: at(0),
    updatedAt: at(96),
  });

  const test = stage(DEP1_ID, {
    stage: 'test',
    status: 'succeeded',
    exitCode: 0,
    startedAt: at(2),
    finishedAt: at(88),
    summary: { stub: false, test_passed: false },
  });
  const policy = stage(DEP1_ID, {
    stage: 'policy',
    status: 'succeeded',
    exitCode: 3,
    startedAt: at(89),
    finishedAt: at(95),
    summary: { decision: 'block', targets: [], failover_allowed: false, requires: plan.requires, mode: 'cli' },
  });

  const artifacts = [
    jsonArtifact(test, 'test_result', 'test/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'test_result', 'policy/test_result.json', testResult, 'policy/contracts/TestResult.schema.json'),
    jsonArtifact(policy, 'plan', 'policy/plan.json', plan, 'contracts/Plan.schema.json'),
    jsonArtifact(policy, 'pii', 'policy/pii.json', pii, 'policy/contracts/PiiReport.schema.json'),
    textArtifact(policy, 'explain.ko', 'policy/explain.ko.md', explainKo),
    textArtifact(policy, 'explain.ja', 'policy/explain.ja.md', explainJa),
    textArtifact(policy, 'audit_log', 'logs/policy.jsonl', JSON.stringify(decisionLine) + '\n'),
  ];
  const planArtifact = artifacts[2]!;
  const piiArtifact = artifacts[3]!;

  const deploymentView = view(
    dep,
    [test, policy],
    policyResult(DEP1_ID, { decision: 'block', planHash: PLAN_HASH, targets: [], failoverAllowed: false, requires: plan.requires ?? [] }, planArtifact.id, piiArtifact.id, at(95)),
    artifacts,
    [auditLog(policy, decisionLine)],
  );

  // 아직 배포된 것이 없으니 route 404, target 없음.
  const frame = (): RoutingFrame => ({
    route: null,
    targets: [],
    agents: { [AGENT_ID]: agentStatus({ status: 'online', serving: null }) },
    caption: '첫 배포가 차단되어 route 와 target 이 아직 없음',
  });

  return {
    id: 1,
    title: '① 방명록 차단',
    description: '재시작 후 상태 유실로 block. 해결 조건 3개 (fix_restart_failure, managed_db, object_storage)',
    defaultPath: `/deployments/${DEP1_ID}`,
    application: applicationView(),
    deployments: [deploymentView],
    frames: [frame],
    frameSeconds: 5,
    agentName: AGENT_NAME,
  };
}
