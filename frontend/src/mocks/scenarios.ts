// MOCK 데이터. 시연용이며 실제 실행 기록이 아님
// 산출물 원문은 레포 예시를 복사해 고친 것 (원본은 수정하지 않음)
//   data/guestbook-v3.test_result.json ← parity/examples/premortem_integration_result.json (조건별 결과를 TestResult 계약 형태로)
//   data/guestbook-v3.plan.json        ← signer/fixtures/plans/block.plan.json + policy/policy.yaml R1b·R5·R6
//   data/guestbook-v1.deploy_result.json ← deploy/examples/deploy_result.json (backend-v2 DeployResult 형태로)
import type {
  AgentStatus,
  ApplicationView,
  DeployResult,
  Deployment,
  DeploymentArtifact,
  DeploymentAuditLog,
  DeploymentView,
  Plan,
  PolicyResult,
  RoutingTarget,
  RoutingTargetHealth,
  SignResult,
  StageExecution,
  StageName,
  TestResult,
  User,
} from "../api/types";
import gbBlockTest from "./data/guestbook-v3.test_result.json";
import gbBlockPlan from "./data/guestbook-v3.plan.json";
import gbActivated from "./data/guestbook-v1.deploy_result.json";

export const ME: User = {
  id: "c0ffee00-7c1e-4a90-9d2b-5e3f1a7b9c01",
  githubId: "100000001",
  login: "Seungpyo1007",
  name: "승표",
  avatarUrl: null,
  createdAt: "2026-09-28T01:00:00.000Z",
  updatedAt: "2026-09-28T01:00:00.000Z",
};
export const TEAMMATE = "c0ffee00-2b8d-4f13-8e6a-1d9c3b5f7a02";

export const IDS = {
  guestbook: "3f6c1a2e-5b7d-4c11-9a2e-6d1f0b7c8e01",
  contacts: "8a2d4e6f-1c3b-4e5a-b7d9-0f2e4c6a8b02",
  agentGuestbook: "b1c2d3e4-0001-4a5b-8c9d-0e1f2a3b4c01",
  agentContacts: "b1c2d3e4-0002-4a5b-8c9d-0e1f2a3b4c02",
  gb1: "5e0c2b7a-9f14-4d3e-8b21-a1c0e9f3d201",
  gb2: "6a1d3c8b-0e25-4f4f-9c32-b2d1fa04e302",
  gb3: "7b2e4d9c-1f36-4a50-ad43-c3e20b15f403",
  ct1: "8c3f5ead-2047-4b61-be54-d4f31c260504",
};

const REGISTRY = "asia-northeast3-docker.pkg.dev/hib-hackathon-1004/hib";
const T0 = Date.parse("2026-10-02T05:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let seq = 0;
const uid = (prefix: string) => `${prefix}-${(++seq).toString(16).padStart(6, "0")}`;

function application(
  id: string,
  name: string,
  slug: string,
  agent: { id: string; name: string },
  requiresApproval: boolean,
): ApplicationView {
  return {
    application: {
      id,
      name,
      slug,
      publicHost: `${slug}.lth.so`,
      sourcePath: `../sample-app/${slug}`,
      imageRepo: `${REGISTRY}/${slug}`,
      containerPort: 8080,
      repo: `SoftBank-Hackathon-Hibiscus/${slug}`,
      defaultBranch: "main",
      policyPath: "policy.yaml",
      testTemplate: "allow",
      requiresApproval,
      createdAt: at(-1440),
      updatedAt: at(-1440),
    },
    healthCheck: {
      applicationId: id,
      enabled: true,
      path: "/health",
      versionPath: "/version",
      method: "GET",
      intervalSeconds: 5,
      timeoutSeconds: 2,
      successStatusMin: 200,
      successStatusMax: 399,
      successThreshold: 1,
      failureThreshold: 3,
      createdAt: at(-1440),
      updatedAt: at(-1440),
    },
    agents: [
      { id: agent.id, name: agent.name, status: "online", lastSeenAt: at(0), createdAt: at(-1440), updatedAt: at(0) },
    ],
  };
}

function deployment(partial: Partial<Deployment> & Pick<Deployment, "id" | "applicationId" | "version">): Deployment {
  return {
    trigger: "webhook",
    sourceRevision: "0000000000000000000000000000000000000000",
    sourceRevisionVerified: true,
    imageDigest: "sha256:" + "0".repeat(64),
    digestSource: "registry",
    requester: ME.id,
    approver: null,
    decision: null,
    status: "queued",
    currentStage: null,
    error: null,
    workDir: "",
    executionMode: "cli",
    deploymentPerformed: false,
    createdAt: at(0),
    updatedAt: at(0),
    ...partial,
  };
}

// 단계 하나와 그 산출물·감사 기록을 함께 생성
class RunBuilder {
  stages: StageExecution[] = [];
  artifacts: DeploymentArtifact[] = [];
  auditLogs: DeploymentAuditLog[] = [];

  constructor(
    readonly deployment: Deployment,
    private minute: number,
  ) {}

  stage(
    stage: StageName,
    status: StageExecution["status"],
    files: Record<string, unknown> = {},
    extra: Partial<StageExecution> = {},
    logs: Record<string, unknown>[] = [],
  ): StageExecution {
    const sequence = { test: 1, policy: 2, sign: 3, deploy: 4 }[stage];
    const attempt = this.stages.filter((item) => item.stage === stage).length + 1;
    const execution: StageExecution = {
      id: uid("stage"),
      deploymentId: this.deployment.id,
      sequence,
      attempt,
      stage,
      status,
      exitCode: status === "running" ? null : status === "failed" ? 1 : 0,
      startedAt: at(this.minute),
      finishedAt: status === "running" ? null : at(this.minute + 0.4),
      artifacts: {},
      summary: null,
      error: null,
      ...extra,
    };
    this.minute += 0.5;
    for (const [name, value] of Object.entries(files)) {
      const id = uid("artifact");
      const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      execution.artifacts[name] = id;
      this.artifacts.push({
        id,
        deploymentId: this.deployment.id,
        stageExecutionId: execution.id,
        name,
        relativePath: `${stage}/${name}.json`,
        mediaType: "application/json",
        content,
        contentHash: "mock",
        schemaName: null,
        validationError: null,
        createdAt: execution.finishedAt ?? execution.startedAt,
      });
    }
    for (const payload of logs) {
      this.auditLogs.push({
        id: uid("audit"),
        deploymentId: this.deployment.id,
        stageExecutionId: execution.id,
        kind: payload.kind as DeploymentAuditLog["kind"],
        payload,
        createdAt: execution.finishedAt ?? execution.startedAt,
      });
    }
    this.stages.push(execution);
    return execution;
  }

  view(policyResult: PolicyResult | null): DeploymentView {
    return {
      deployment: this.deployment,
      stages: this.stages,
      policyResult,
      artifacts: this.artifacts,
      auditLogs: this.auditLogs,
    };
  }
}

function passedTest(d: Deployment, app: string): TestResult {
  const condition = (name: "none" | "restart" | "replace") => ({
    name,
    total: 20,
    matched: 20,
    failed: false,
    mismatches: [],
  });
  return {
    run_id: d.id,
    app,
    digest: d.imageDigest,
    source_revision: d.sourceRevision,
    passed: true,
    match: { total: 20, matched: 20 },
    failures: [],
    facts: { conditions: [condition("none"), condition("restart"), condition("replace")] },
  };
}

function policyResultOf(d: Deployment, plan: Plan, planArtifactId: string | undefined): PolicyResult {
  return {
    deploymentId: d.id,
    decision: plan.decision,
    planHash: plan.plan_hash,
    targets: plan.targets,
    failoverAllowed: plan.failover_allowed,
    requires: plan.requires ?? [],
    planPath: null,
    piiPath: null,
    planArtifactId: planArtifactId ?? null,
    piiArtifactId: null,
    createdAt: d.createdAt,
    updatedAt: d.createdAt,
  };
}

const deployLog = (d: Deployment, plan: Plan) => ({
  kind: "deploy",
  time: d.createdAt,
  run_id: d.id,
  digest: d.imageDigest,
  source_revision: d.sourceRevision,
  decision: plan.decision,
  targets: plan.targets,
  rule_ids: plan.rules.filter((rule) => rule.result !== "not_matched").map((rule) => rule.id),
  plan_hash: plan.plan_hash,
});

const signedLog = (d: Deployment, sign: SignResult) => ({
  kind: "sign",
  time: sign.signed_at,
  run_id: d.id,
  digest: d.imageDigest,
  source_revision: d.sourceRevision,
  plan_hash: sign.plan_hash,
  result: "signed",
  requester: sign.requester,
  approver: sign.approver,
  reason: null,
  signature_ref: sign.signature_ref,
});

function signResult(d: Deployment, plan: Plan, slug: string, approver: string): SignResult {
  return {
    run_id: d.id,
    digest: d.imageDigest,
    source_revision: d.sourceRevision,
    plan_hash: plan.plan_hash,
    targets: plan.targets,
    failover_allowed: plan.failover_allowed,
    requester: d.requester,
    approver,
    signature_ref: `cosign:${REGISTRY}/${slug}@${d.imageDigest}`,
    signed_at: d.updatedAt,
  };
}

const allowPlan = (d: Deployment, app: string, hash: string): Plan => ({
  run_id: d.id,
  app,
  digest: d.imageDigest,
  source_revision: d.sourceRevision,
  decision: "allow",
  targets: ["onprem", "cloud_run"],
  failover_allowed: true,
  rules: [
    ...["R1", "R1b", "R1c", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => ({ id, result: "not_matched" as const })),
    {
      id: "default",
      result: "matched",
      reason: "개인정보 없음, 테스트 통과: 하이브리드 배포 허용",
      reason_i18n: { ja: "個人情報なし、テスト合格：ハイブリッドデプロイを許可" },
    },
  ],
  plan_hash: hash,
});

export interface MockState {
  applications: ApplicationView[];
  deployments: Map<string, DeploymentView>;
  targets: { target: RoutingTarget; health: RoutingTargetHealth | null }[];
  routes: Map<string, { targetId: string; revision: number }>;
  agents: Map<string, AgentStatus>;
  // 시연용 시간 흐름
  onpremFailedAt: number | null;
  approvedAt: number | null;
}

export function healthy(target: RoutingTarget, now: number): RoutingTargetHealth {
  return {
    targetId: target.id,
    deploymentId: target.deploymentId,
    status: "healthy",
    observedAt: new Date(now - 2_000).toISOString(),
    expiresAt: new Date(now + 15_000).toISOString(),
    reason: null,
    failureKind: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 12,
    updatedAt: new Date(now - 2_000).toISOString(),
  };
}

export function routingTarget(
  id: string,
  applicationId: string,
  deploymentId: string,
  kind: RoutingTarget["kind"],
  extra: Partial<RoutingTarget>,
): RoutingTarget {
  return {
    id,
    applicationId,
    deploymentId,
    kind,
    agentId: null,
    localPort: null,
    gatewayPort: null,
    url: null,
    enabled: true,
    createdAt: at(13),
    updatedAt: at(13),
    ...extra,
  };
}

export function createState(now = Date.now()): MockState {
  seq = 0;
  const gbApp = application(IDS.guestbook, "guestbook", "guestbook", { id: IDS.agentGuestbook, name: "mac-mini-01" }, false);
  const ctApp = application(IDS.contacts, "contacts", "contacts", { id: IDS.agentContacts, name: "onprem-02" }, true);
  const deployments = new Map<string, DeploymentView>();

  // ② 허용 → 배포 완료, 트래픽 전환
  {
    const activated = gbActivated as DeployResult;
    const d = deployment({
      id: IDS.gb1,
      applicationId: IDS.guestbook,
      version: 1,
      sourceRevision: "4f2a9c1e7b3d5f80a6c2e4b1d9f7a3c5e8b0d2f4",
      imageDigest: activated.digest,
      decision: "allow",
      status: "succeeded",
      currentStage: "deploy",
      approver: "auto",
      deploymentPerformed: true,
      createdAt: at(10),
      updatedAt: at(12),
    });
    const plan = allowPlan(d, "guestbook", "7142ff914e5a7a755bde2a95e6bbe83ee11909540b091a383ada79c8b5697c1f");
    const sign = signResult(d, plan, "guestbook", "auto");
    const run = new RunBuilder(d, 10);
    run.stage("test", "succeeded", { test_result: passedTest(d, "guestbook") });
    const policy = run.stage("policy", "succeeded", { plan }, {}, [deployLog(d, plan)]);
    run.stage("sign", "succeeded", { sign_result: sign }, { summary: sign }, [signedLog(d, sign)]);
    run.stage("deploy", "succeeded", { deploy_result: activated });
    deployments.set(d.id, run.view(policyResultOf(d, plan, policy.artifacts.plan)));
  }

  // ③ 후보 검사 실패 → held, 기존 서비스 유지
  {
    const d = deployment({
      id: IDS.gb2,
      applicationId: IDS.guestbook,
      version: 2,
      sourceRevision: "b83e0d6a2c4f19e7d5a3b1c9e7f5d3a1b9c7e5f3",
      imageDigest: "sha256:d90d6bd2d450675086139ab4448e851b26d2e28b4132dcc90ad0f2b7719babc5",
      decision: "allow",
      status: "failed",
      currentStage: "deploy",
      approver: "auto",
      error: "[deploy] held: Candidate checks failed; kept the current version",
      createdAt: at(60),
      updatedAt: at(63),
    });
    const plan = allowPlan(d, "guestbook", "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae");
    const sign = signResult(d, plan, "guestbook", "auto");
    const image = `${REGISTRY}/guestbook@${d.imageDigest}`;
    const held: DeployResult = {
      run_id: d.id,
      digest: d.imageDigest,
      image,
      decision: "held",
      signature: { verified: true, ref: sign.signature_ref, key: "signer/keys/cosign.pub", tlog: "verified" },
      targets_planned: ["onprem", "cloud_run"],
      failover_allowed: true,
      targets: [
        { target: "cloud_run", phase: "candidate", result: "ok", revision: "guestbook-d90d6bd2d450", candidate_url: "https://cand---guestbook-k6pucunkwq-du.a.run.app" },
        { target: "onprem", phase: "candidate", result: "ok", job_id: `${d.id}-candidate-01`, container: "guestbook-candidate-6a1d3c8b", candidate_url: "http://127.0.0.1:18082" },
        { target: "cloud_run", phase: "discard", result: "ok" },
        { target: "onprem", phase: "discard", result: "ok", job_id: `${d.id}-discard-01` },
      ],
      checks: [
        {
          target: "cloud_run",
          mode: "candidate",
          pass: false,
          url: "https://cand---guestbook-k6pucunkwq-du.a.run.app",
          checker: "http-health",
          checks: [{ name: "GET /health", pass: false, status: 503, ms: 2004, error: "status 503" }],
        },
        { target: "onprem", mode: "candidate", pass: true, url: "http://127.0.0.1:18082", checker: "onprem-agent", checks: [] },
      ],
      routing: { result: "skipped" },
      started_at: at(61),
      finished_at: at(63),
      error: "Candidate checks failed; kept the current version",
    };
    const run = new RunBuilder(d, 60);
    run.stage("test", "succeeded", { test_result: passedTest(d, "guestbook") });
    const policy = run.stage("policy", "succeeded", { plan }, {}, [deployLog(d, plan)]);
    run.stage("sign", "succeeded", { sign_result: sign }, { summary: sign }, [signedLog(d, sign)]);
    run.stage("deploy", "failed", { deploy_result: held }, { exitCode: 3, error: "held: Candidate checks failed; kept the current version" });
    deployments.set(d.id, run.view(policyResultOf(d, plan, policy.artifacts.plan)));
  }

  // ① 테스트 조건별 실패 → 정책 차단. 소스 검증(true)과 차단이 같이 있음
  {
    const plan = gbBlockPlan as Plan;
    const test = gbBlockTest as TestResult;
    const d = deployment({
      id: IDS.gb3,
      applicationId: IDS.guestbook,
      version: 3,
      sourceRevision: plan.source_revision!,
      imageDigest: plan.digest,
      decision: "block",
      status: "blocked",
      currentStage: "policy",
      createdAt: at(120),
      updatedAt: at(121),
    });
    const run = new RunBuilder(d, 120);
    run.stage("test", "succeeded", { test_result: test });
    const policy = run.stage("policy", "succeeded", { plan }, { exitCode: 3 }, [deployLog(d, plan)]);
    deployments.set(d.id, run.view(policyResultOf(d, plan, policy.artifacts.plan)));
  }

  // 승인 대기 (개인정보 후보). 다른 사람이 요청해서 내가 승인할 수 있음
  {
    const d = deployment({
      id: IDS.ct1,
      applicationId: IDS.contacts,
      version: 1,
      requester: TEAMMATE,
      sourceRevision: "e1a7c3f5b9d2e4a6c8f0b2d4e6a8c0f2b4d6e8a0",
      imageDigest: "sha256:3c9e1f7a2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f",
      decision: "needs_approval",
      status: "awaiting_approval",
      currentStage: "sign",
      createdAt: at(150),
      updatedAt: at(151),
    });
    const plan: Plan = {
      run_id: d.id,
      app: "contacts",
      digest: d.imageDigest,
      source_revision: d.sourceRevision,
      decision: "needs_approval",
      targets: ["onprem"],
      failover_allowed: false,
      requires: [
        {
          id: "human_review_pii",
          hint: "해당 칼럼이 개인정보인지 사람이 확인",
          hint_i18n: { ja: "該当カラムが個人情報かどうかを人が確認" },
          rule_id: "R3",
          allowed_targets: ["onprem"],
        },
      ],
      rules: [
        { id: "R1", result: "not_matched" },
        { id: "R1b", result: "not_matched" },
        { id: "R1c", result: "not_matched" },
        { id: "R2", result: "not_matched" },
        {
          id: "R3",
          result: "matched",
          reason: "확신 없는 개인정보 후보(todos.note, free_text_maybe_address): src/routes/todos.js:41",
          reason_i18n: { ja: "確信のない個人情報候補（todos.note、free_text_maybe_address）：src/routes/todos.js:41" },
        },
        {
          id: "R4",
          result: "matched",
          reason: "개인정보(contact, phone) 발견: src/routes/signup.js:24",
          reason_i18n: { ja: "個人情報（contact、phone）を検出：src/routes/signup.js:24" },
        },
        { id: "R5", result: "not_matched" },
        { id: "R6", result: "not_matched" },
        { id: "R7", result: "not_matched" },
      ],
      plan_hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    };
    const run = new RunBuilder(d, 150);
    run.stage("test", "succeeded", { test_result: passedTest(d, "contacts") });
    const policy = run.stage("policy", "succeeded", { plan }, { exitCode: 2 }, [deployLog(d, plan)]);
    deployments.set(d.id, run.view(policyResultOf(d, plan, policy.artifacts.plan)));
  }

  const gbOnprem = routingTarget("t-gb1-onprem", IDS.guestbook, IDS.gb1, "onprem", {
    agentId: IDS.agentGuestbook,
    localPort: 18081,
    gatewayPort: 20001,
  });
  const gbCloud = routingTarget("t-gb1-cloudrun", IDS.guestbook, IDS.gb1, "cloud_run", {
    url: "https://guestbook-k6pucunkwq-du.a.run.app",
  });

  return {
    applications: [gbApp, ctApp],
    deployments,
    targets: [
      { target: gbOnprem, health: healthy(gbOnprem, now) },
      { target: gbCloud, health: healthy(gbCloud, now) },
    ],
    routes: new Map([[IDS.guestbook, { targetId: gbOnprem.id, revision: 1 }]]),
    agents: new Map<string, AgentStatus>([
      [
        IDS.agentGuestbook,
        {
          schema_version: 1,
          agent_id: IDS.agentGuestbook,
          status: "online",
          last_seen_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          received_at: new Date(now).toISOString(),
          serving: { run_id: IDS.gb1, digest: (gbActivated as DeployResult).digest, container: "guestbook-5e0c2b7a" },
          public_url: null,
        },
      ],
      [
        IDS.agentContacts,
        {
          schema_version: 1,
          agent_id: IDS.agentContacts,
          status: "online",
          last_seen_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          received_at: new Date(now).toISOString(),
          serving: null,
          public_url: null,
        },
      ],
    ]),
    onpremFailedAt: null,
    approvedAt: null,
  };
}

export { RunBuilder, deployLog, signedLog, signResult, policyResultOf };
