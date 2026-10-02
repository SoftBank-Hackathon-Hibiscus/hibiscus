export type JobAction = "candidate" | "activate" | "rollback" | "discard";

export interface AgentHealthCheck {
  enabled: boolean;
  path: string;
  version_path?: string;
  method: "GET" | "HEAD";
  interval_seconds: number;
  timeout_seconds: number;
  success_status_min: number;
  success_status_max: number;
  success_threshold: number;
  failure_threshold: number;
}

export interface AgentJob {
  schema_version: 1;
  agent_id: string;
  job_id: string;
  run_id: string;
  action: JobAction;
  digest: string;
  image?: string;
  plan_hash?: string;
  to_digest?: string;
  runtime: { container_port: number };
  health_check: AgentHealthCheck;
  created_at: string;
  deadline: string;
  attempt: number;
  lease_until: string;
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

export interface HealthCheckResult {
  run_id: string;
  target: "onprem";
  mode: "candidate";
  pass: boolean;
  url: string;
  checks: Array<{
    name: "health" | "version";
    pass: boolean;
    ms: number;
    status?: number;
    error?: string;
  }>;
}

export interface AgentJobResult {
  schema_version: 1;
  agent_id: string;
  job_id: string;
  run_id: string;
  action: JobAction;
  attempt: number;
  result: "ok" | "error";
  candidate?: CandidateContainer;
  check?: HealthCheckResult;
  previous?: ServingContainer;
  serving?: ServingContainer;
  error?: string;
  finished_at: string;
}

export interface ManagedContainer extends ServingContainer {
  image: string;
  url: string;
  host_port: number;
  container_port: number;
  role: "candidate" | "serving" | "standby";
}

export type CachedJobResult = Omit<AgentJobResult, "attempt">;

export interface AgentState {
  schema_version: 1;
  serving_container: string | null;
  containers: Record<string, ManagedContainer>;
  completed_jobs: Record<string, CachedJobResult>;
}

export interface BackendAgentClient {
  nextJob(): Promise<AgentJob | undefined>;
  submitResult(result: AgentJobResult): Promise<void>;
  heartbeat(serving: ServingContainer | null): Promise<void>;
  forwards(): Promise<SshForward[]>;
}

export interface SshForward {
  target_id: string;
  gateway_port: number;
  local_port: number;
}

export interface ContainerRuntime {
  createCandidate(
    job: AgentJob,
    existing?: ManagedContainer,
  ): Promise<ManagedContainer>;
  activate(
    target: ManagedContainer,
    previous?: ManagedContainer,
  ): Promise<void>;
  remove(container: ManagedContainer): Promise<void>;
  reconcile(
    containers: ManagedContainer[],
    servingContainer: string | null,
  ): Promise<ManagedContainer[]>;
}

export interface SignatureVerifier {
  verify(job: AgentJob): Promise<void>;
}

export interface HealthProbe {
  check(job: AgentJob, candidate: ManagedContainer): Promise<HealthCheckResult>;
}

export class FatalAgentError extends Error {}
