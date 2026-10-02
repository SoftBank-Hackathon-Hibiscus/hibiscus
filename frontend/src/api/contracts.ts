// 산출물(artifacts[].content) 안의 JSON 형식. contracts/ 와 #26 deploy-result.type.ts 를 옮겼다.
// 화면은 이 타입을 "있을 수도 있는 값"으로 다룬다 (optional 필드 많음).

import type { Decision, TargetKind } from './types';

export type ConditionName = 'none' | 'restart' | 'replace';

export interface TestMismatch {
  index: number;
  request: string;
  related_fact?: string;
  related_storage?: string;
  related_kind?: string;
}

export interface TestCondition {
  name: ConditionName;
  total: number;
  matched: number;
  failed: boolean;
  mismatches: TestMismatch[];
}

export interface TestResult {
  run_id: string;
  app: string;
  digest: string;
  source_revision?: string;
  passed: boolean;
  match: { total: number; matched: number };
  failures?: Array<Record<string, unknown>>;
  facts?: {
    db?: 'sqlite' | 'postgres' | 'mysql' | 'none';
    writes_local_file?: string[];
    migration?: {
      destructive: boolean;
      backward_compatible: boolean;
      findings: Array<{ kind: string; statement: string; evidence?: string }>;
    };
    conditions?: TestCondition[];
    storage?: Array<{ kind: string; path: string; storage: string }>;
  };
}

export interface PlanRequire {
  id: string;
  hint?: string;
  hint_i18n?: { ja?: string };
  rule_id: string;
  allowed_targets: string[];
}

export interface PlanRule {
  id: string;
  result: 'matched' | 'not_matched' | 'matched_after_block';
  reason?: string;
  reason_i18n?: { ja?: string };
}

export interface Plan {
  run_id: string;
  app: string;
  digest: string;
  source_revision?: string;
  decision: Decision;
  targets: string[];
  failover_allowed: boolean;
  requires?: PlanRequire[];
  rules: PlanRule[];
  plan_hash: string;
}

export interface PiiReport {
  run_id: string;
  pii?: Array<{
    table: string;
    column: string;
    kind: string;
    evidence: string;
    confident: boolean;
    source?: 'heuristic' | 'llm' | 'replay';
  }>;
}

export interface SignResult {
  run_id: string;
  digest: string;
  source_revision?: string;
  plan_hash: string;
  targets: string[];
  failover_allowed: boolean;
  requester: string;
  approver: string;
  signature_ref: string;
  signed_at: string;
}

export interface Approval {
  run_id: string;
  digest: string;
  plan_hash: string;
  plan_sha256: string;
  requester: string;
  approver: string;
  approved_at: string;
}

/** decisions.jsonl 한 줄 (auditLogs[].payload) */
export interface DecisionLogDeploy {
  kind: 'deploy';
  time: string;
  run_id: string;
  digest: string;
  source_revision?: string;
  decision: Decision;
  targets: string[];
  rule_ids: string[];
  plan_hash: string;
}

export interface SignLog {
  kind: 'sign';
  time: string;
  run_id: string;
  digest: string;
  source_revision?: string;
  plan_hash: string;
  result: 'signed' | 'refused';
  requester: string;
  approver: string | null;
  reason: string | null;
  signature_ref: string | null;
}

// ---- deploy_result (PR #26 backend-v2/src/deployment/types/deploy-result.type.ts) ----

export type DeployDecision = 'activated' | 'held' | 'rolled_back' | 'error';

export interface DeployTargetStep {
  target: TargetKind;
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
  target: TargetKind;
  mode: 'candidate' | 'live';
  pass: boolean;
  url?: string;
  checker: string;
  checks: unknown[];
}

export interface DeployRouting {
  result: 'ok' | 'error' | 'skipped';
  target_id?: string;
  kind?: TargetKind;
  revision?: number;
  standby_target_id?: string;
  standby_enabled?: boolean;
  reason?: string;
  error?: string;
}

export interface DeployResult {
  run_id: string;
  digest: string;
  image: string | null;
  decision: DeployDecision;
  signature: {
    verified: boolean;
    ref: string;
    key: string;
    tlog?: 'verified' | 'ignored';
  } | null;
  targets_planned: string[];
  failover_allowed: boolean | null;
  targets: DeployTargetStep[];
  checks: DeployCheck[];
  routing: DeployRouting;
  started_at: string;
  finished_at?: string;
  error?: string;
}
