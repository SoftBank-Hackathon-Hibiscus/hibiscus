import type { Request } from 'express';
import type { Agent } from '../../database/schema.js';

export const AGENT_ROUTE = 'auth.agent';
export const JOB_ACTIONS = [
  'candidate',
  'activate',
  'rollback',
  'discard',
] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export interface AgentRequest extends Request {
  agent: Agent;
}

export interface ServingContainer {
  run_id: string;
  digest: string;
  container: string;
}

export interface CandidateContainer {
  digest: string;
  container: string;
  url: string;
}

export interface AgentRuntimeConfig {
  container_port: number;
}

export interface AgentHealthCheckConfig {
  enabled: boolean;
  path: string;
  version_path?: string;
  method: 'GET' | 'HEAD';
  interval_seconds: number;
  timeout_seconds: number;
  success_status_min: number;
  success_status_max: number;
  success_threshold: number;
  failure_threshold: number;
}

export interface AgentJobResultPayload {
  schema_version: 1;
  agent_id: string;
  job_id: string;
  run_id: string;
  action: JobAction;
  attempt: number;
  result: 'ok' | 'error';
  candidate?: CandidateContainer;
  check?: Record<string, unknown>;
  previous?: ServingContainer;
  serving?: ServingContainer;
  error?: string;
  finished_at: string;
}
