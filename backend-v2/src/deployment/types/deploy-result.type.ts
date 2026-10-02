import type { AgentJobResultPayload } from '../../agent/types/agent.type.js';
import type { HealthCheckConfig } from '../../database/schema.js';
import type { DeploymentSignResult } from './deployment.type.js';

// 배포 단계가 다루는 대상. 전환 순서도 이 순서다 (Cloud Run 먼저: 되돌리기가 빠름)
export const DEPLOY_TARGETS = ['cloud_run', 'onprem'] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/** activated: 전환 완료 / held: 전환 전 검사 실패로 기존 유지 / rolled_back: 전환 중 실패로 되돌림 / error: 시작 불가·내부 오류 */
export type DeployDecision = 'activated' | 'held' | 'rolled_back' | 'error';

export interface DeployTargetStep {
  target: DeployTarget;
  phase: 'candidate' | 'activate' | 'discard' | 'rollback';
  result: 'ok' | 'error' | 'skipped';
  revision?: string;
  candidate_url?: string;
  previous?: string | null;
  serving?: string | null;
  job_id?: string;
  container?: string;
  reason?: string;
  error?: string;
}

export interface DeployCheck {
  target: DeployTarget;
  mode: 'candidate' | 'live';
  pass: boolean;
  url?: string;
  checker: string;
  checks: unknown[];
}

export interface DeployRouting {
  result: 'ok' | 'error' | 'skipped';
  target_id?: string;
  kind?: DeployTarget;
  revision?: number;
  standby_target_id?: string;
  standby_enabled?: boolean;
  reason?: string;
  error?: string;
}

/** <run>/deploy/deploy_result.json. backend가 DB 산출물로 저장한다 */
export interface DeployResult {
  run_id: string;
  digest: string;
  image: string | null;
  decision: DeployDecision;
  signature: { verified: boolean; ref: string; key: string } | null;
  targets_planned: string[];
  failover_allowed: boolean | null;
  targets: DeployTargetStep[];
  checks: DeployCheck[];
  routing: DeployRouting;
  started_at: string;
  finished_at?: string;
  error?: string;
}

/** 배포 전에 거부해야 하는 입력 (서명·계약 문제). 클라우드를 건드리기 전에 던진다 */
export class DeployRejected extends Error {}

export interface CloudRunPort {
  candidate(
    imageRef: string,
    runId: string,
  ): Promise<{ revision: string; candidateUrl: string }>;
  activate(): Promise<{ previous: string; serving: string }>;
  rollback(revision: string): Promise<void>;
  discard(): Promise<void>;
  /** 후보 태그 주소(https://<tag>---svc-...) → 서비스 기본 주소 */
  serviceUrl(candidateUrl: string): string;
}

export interface OnpremJobSpec {
  agentId: string;
  runId: string;
  action: 'candidate' | 'activate' | 'rollback' | 'discard';
  digest: string;
  image?: string;
  planHash?: string;
  toDigest?: string;
}

export interface OnpremJobOutcome {
  jobId: string;
  status: 'succeeded' | 'failed' | 'expired' | 'timeout';
  payload?: AgentJobResultPayload;
  error?: string;
}

export interface OnpremPort {
  run(spec: OnpremJobSpec): Promise<OnpremJobOutcome>;
}

export interface RoutingTargetInput {
  applicationId: string;
  deploymentId: string;
  kind: DeployTarget;
  agentId?: string;
  localPort?: number;
  url?: string;
  enabled: boolean;
}

export interface RoutingPort {
  /** 같은 배포·종류의 대상이 있으면 그 id를, 없으면 새로 만든 id를 돌려준다 */
  ensureTarget(input: RoutingTargetInput): string;
  switchTo(
    applicationId: string,
    targetId: string,
    changedBy: string,
    reason: string,
  ): number;
}

export interface SignatureVerifierPort {
  verify(
    sign: DeploymentSignResult,
    imageRepo: string,
  ): Promise<{ imageRef: string; key: string }>;
}

export interface HealthCheckerPort {
  check(
    target: DeployTarget,
    baseUrl: string,
    config: HealthCheckConfig,
  ): Promise<DeployCheck>;
}

export interface DeployInput {
  deploymentId: string;
  digest: string;
  applicationId: string;
  imageRepo: string;
  sign: DeploymentSignResult;
  /** 온프레에 쓸 Agent. 없으면 온프레는 skipped */
  agentId: string | null;
  healthCheck: HealthCheckConfig;
  /** 라우팅 변경 기록에 남길 사용자 id */
  changedBy: string;
}
