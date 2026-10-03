// mock 공통 상수와 조립 함수. 레포 fixture(parity/examples, signer/fixtures/plans,
// deploy/examples, policy/fixtures)에서 필요한 값만 옮겨 backend-v2 응답 형태로 만든다.

import type { DeployResult, SignLog, DecisionLogDeploy } from '../api/contracts';
import type {
  AgentStatusResponse,
  ApplicationView,
  Deployment,
  DeploymentArtifact,
  DeploymentAuditLog,
  DeploymentView,
  PolicyResult,
  RouteSnapshot,
  RoutingTarget,
  RoutingTargetHealth,
  RoutingTargetView,
  StageExecution,
  StageName,
  StageStatus,
} from '../api/types';

export const APP_ID = 'a4f3c2e1-0000-4000-8000-00000000ab01';
export const AGENT_ID = '7e9b1d2c-0000-4000-8000-0000000a9e01';
export const AGENT_NAME = 'mac-taehyun';
export const IMAGE_REPO = 'asia-northeast3-docker.pkg.dev/hib/apps/guestbook';
export const CLOUD_RUN_URL = 'https://guestbook-k6pucunkwq-du.a.run.app';
export const REQUESTER = 'u-ryurujxx';

export const T0 = Date.parse('2026-10-02T09:00:00.000Z');
export const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const SEQUENCE: Record<StageName, number> = { test: 1, policy: 2, sign: 3, deploy: 4 };

export function applicationView(overrides: Partial<ApplicationView['application']> = {}): ApplicationView {
  return {
    application: {
      id: APP_ID,
      name: 'guestbook',
      slug: 'guestbook',
      publicHost: 'guestbook.lth.so',
      sourcePath: '/srv/hibiscus/apps/guestbook',
      imageRepo: IMAGE_REPO,
      containerPort: 8080,
      repo: 'SoftBank-Hackathon-Hibiscus/guestbook',
      defaultBranch: 'main',
      policyPath: null,
      testTemplate: 'allow',
      requiresApproval: false,
      createdAt: at(-86400),
      updatedAt: at(-86400),
      ...overrides,
    },
    healthCheck: {
      applicationId: APP_ID,
      enabled: true,
      path: '/health',
      versionPath: null,
      method: 'GET',
      intervalSeconds: 5,
      timeoutSeconds: 2,
      successStatusMin: 200,
      successStatusMax: 399,
      successThreshold: 1,
      failureThreshold: 2,
      createdAt: at(-86400),
      updatedAt: at(-86400),
    },
    agents: [
      {
        id: AGENT_ID,
        name: AGENT_NAME,
        status: 'online',
        lastSeenAt: at(0),
        createdAt: at(-86400),
        updatedAt: at(0),
      },
    ],
  };
}

export function deployment(overrides: Partial<Deployment> & Pick<Deployment, 'id' | 'version' | 'sourceRevision' | 'imageDigest' | 'status'>): Deployment {
  return {
    applicationId: APP_ID,
    trigger: 'webhook',
    sourceRevisionVerified: false,
    digestSource: 'registry',
    requester: REQUESTER,
    approver: null,
    decision: null,
    currentStage: null,
    error: null,
    workDir: '',
    executionMode: 'cli',
    deploymentPerformed: false,
    createdAt: at(0),
    updatedAt: at(120),
    ...overrides,
  };
}

export interface StageInput {
  stage: StageName;
  status: StageStatus;
  exitCode?: number | null;
  startedAt: string;
  finishedAt?: string | null;
  summary?: unknown;
  error?: string | null;
  attempt?: number;
}

export function stage(deploymentId: string, input: StageInput): StageExecution {
  return {
    id: `${deploymentId}-${input.stage}-${input.attempt ?? 1}`,
    deploymentId,
    sequence: SEQUENCE[input.stage],
    attempt: input.attempt ?? 1,
    stage: input.stage,
    status: input.status,
    exitCode: input.exitCode ?? null,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    artifacts: {},
    summary: input.summary ?? null,
    error: input.error ?? null,
  };
}

export function jsonArtifact(execution: StageExecution, name: string, relativePath: string, value: unknown, schemaName: string | null = null): DeploymentArtifact {
  const content = JSON.stringify(value, null, 2) + '\n';
  const artifact: DeploymentArtifact = {
    id: `${execution.id}-${name}`,
    deploymentId: execution.deploymentId,
    stageExecutionId: execution.id,
    name,
    relativePath,
    mediaType: 'application/json',
    content,
    contentHash: fakeHash(content),
    schemaName,
    validationError: null,
    createdAt: execution.finishedAt ?? execution.startedAt,
  };
  execution.artifacts[name] = artifact.id;
  return artifact;
}

export function textArtifact(execution: StageExecution, name: string, relativePath: string, content: string): DeploymentArtifact {
  const artifact: DeploymentArtifact = {
    id: `${execution.id}-${name}`,
    deploymentId: execution.deploymentId,
    stageExecutionId: execution.id,
    name,
    relativePath,
    mediaType: 'text/plain',
    content,
    contentHash: fakeHash(content),
    schemaName: null,
    validationError: null,
    createdAt: execution.finishedAt ?? execution.startedAt,
  };
  execution.artifacts[name] = artifact.id;
  return artifact;
}

export function auditLog(execution: StageExecution, payload: DecisionLogDeploy | SignLog): DeploymentAuditLog {
  return {
    id: `${execution.id}-audit-${payload.kind}`,
    deploymentId: execution.deploymentId,
    stageExecutionId: execution.id,
    kind: payload.kind,
    payload: payload as unknown as Record<string, unknown>,
    createdAt: execution.finishedAt ?? execution.startedAt,
  };
}

export function policyResult(deploymentId: string, input: Pick<PolicyResult, 'decision' | 'planHash' | 'targets' | 'failoverAllowed' | 'requires'>, planArtifactId: string | null, piiArtifactId: string | null, time: string): PolicyResult {
  return {
    deploymentId,
    ...input,
    planPath: null,
    piiPath: null,
    planArtifactId,
    piiArtifactId,
    createdAt: time,
    updatedAt: time,
  };
}

export function view(deployment: Deployment, stages: StageExecution[], policy: PolicyResult | null, artifacts: DeploymentArtifact[], auditLogs: DeploymentAuditLog[]): DeploymentView {
  return { deployment, stages, policyResult: policy, artifacts, auditLogs };
}

// ---- routing / agent ----

export function onpremTarget(id: string, deploymentId: string, localPort: number, gatewayPort: number, enabled = true): RoutingTarget {
  return {
    id,
    applicationId: APP_ID,
    deploymentId,
    kind: 'onprem',
    agentId: AGENT_ID,
    localPort,
    gatewayPort,
    url: null,
    enabled,
    createdAt: at(100),
    updatedAt: at(100),
  };
}

export function cloudRunTarget(id: string, deploymentId: string, enabled = true): RoutingTarget {
  return {
    id,
    applicationId: APP_ID,
    deploymentId,
    kind: 'cloud_run',
    agentId: null,
    localPort: null,
    gatewayPort: null,
    url: CLOUD_RUN_URL,
    enabled,
    createdAt: at(100),
    updatedAt: at(100),
  };
}

export interface HealthInput {
  status: RoutingTargetHealth['status'];
  reason?: string | null;
  failureKind?: RoutingTargetHealth['failureKind'];
  consecutiveFailures?: number;
  consecutiveSuccesses?: number;
  /** 관측 시각. 주지 않으면 호출 시점 */
  observedAt?: string;
  intervalSeconds?: number;
}

export function health(target: RoutingTarget, input: HealthInput): RoutingTargetHealth {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const interval = input.intervalSeconds ?? 5;
  return {
    targetId: target.id,
    deploymentId: target.deploymentId,
    status: input.status,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 2 * interval * 1000).toISOString(),
    reason: input.reason ?? (input.status === 'healthy' ? 'Health monitor passed' : null),
    failureKind: input.failureKind ?? null,
    consecutiveFailures: input.consecutiveFailures ?? 0,
    consecutiveSuccesses: input.consecutiveSuccesses ?? (input.status === 'healthy' ? 1 : 0),
    updatedAt: observedAt,
  };
}

export function targetView(target: RoutingTarget, h: HealthInput | null): RoutingTargetView {
  return { target, health: h ? health(target, h) : null };
}

export function route(target: RoutingTarget, revision: number, h: HealthInput | null): RouteSnapshot {
  return { applicationId: APP_ID, target, revision, health: h ? health(target, h) : null };
}

export function agentStatus(input: Partial<AgentStatusResponse> & { status: AgentStatusResponse['status'] }): AgentStatusResponse {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    agent_id: AGENT_ID,
    last_seen_at: now,
    updated_at: now,
    received_at: now,
    serving: null,
    public_url: null,
    ...input,
  };
}

/** 한 시점의 Application Detail 상태. mock 데이터 소스가 시간에 따라 프레임을 넘긴다. */
export interface RoutingFrame {
  /** null 이면 GET routing 이 404 */
  route: RouteSnapshot | null;
  targets: RoutingTargetView[];
  agents: Record<string, AgentStatusResponse>;
  /** 화면 상단 안내 문구 (mock 전용) */
  caption: string;
}

export function deployResultActivated(input: {
  runId: string;
  digest: string;
  cloudRevision: string;
  onpremContainer: string;
  onpremPort: number;
  routingTargetId: string;
  standbyTargetId: string;
  startedAt: string;
  finishedAt: string;
}): DeployResult {
  const candidateUrl = CLOUD_RUN_URL.replace('https://', 'https://cand---');
  return {
    run_id: input.runId,
    digest: input.digest,
    image: `${IMAGE_REPO}@${input.digest}`,
    decision: 'activated',
    signature: {
      verified: true,
      ref: `cosign:${IMAGE_REPO}@${input.digest}`,
      key: '/srv/hibiscus/signer/keys/cosign.pub',
      tlog: 'ignored',
    },
    targets_planned: ['onprem', 'cloud_run'],
    failover_allowed: true,
    targets: [
      { target: 'cloud_run', phase: 'candidate', result: 'ok', revision: input.cloudRevision, candidate_url: candidateUrl },
      { target: 'onprem', phase: 'candidate', result: 'ok', job_id: `${input.runId}-candidate-01`, container: input.onpremContainer, candidate_url: `http://127.0.0.1:${input.onpremPort}` },
      { target: 'cloud_run', phase: 'activate', result: 'ok', previous: 'guestbook-v1', serving: input.cloudRevision },
      { target: 'onprem', phase: 'activate', result: 'ok', job_id: `${input.runId}-activate-01`, previous: null, serving: input.onpremContainer },
    ],
    checks: [
      { target: 'cloud_run', mode: 'candidate', pass: true, url: `${candidateUrl}/health`, checker: 'http-health', checks: [{ name: 'health', pass: true, status: 200, ms: 412, error: null }] },
      { target: 'onprem', mode: 'candidate', pass: true, url: `http://127.0.0.1:${input.onpremPort}`, checker: 'onprem-agent', checks: [{ name: 'health', pass: true, ms: 38 }] },
    ],
    routing: {
      result: 'ok',
      target_id: input.routingTargetId,
      kind: 'onprem',
      revision: 1,
      standby_target_id: input.standbyTargetId,
      standby_enabled: true,
    },
    started_at: input.startedAt,
    finished_at: input.finishedAt,
  };
}

function fakeHash(content: string): string {
  // 화면 표시용 가짜 해시. 실제 sha256 이 아니다.
  let h1 = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h1 ^= content.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + 'a'.repeat(56)).slice(0, 64);
}
