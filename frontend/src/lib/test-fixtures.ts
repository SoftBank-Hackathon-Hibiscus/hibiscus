import type { DeployResult, Deployment, DeploymentArtifact, StageExecution } from "../api/types";

export function makeDeployment(patch: Partial<Deployment> = {}): Deployment {
  return {
    id: "d1",
    applicationId: "a1",
    version: 1,
    trigger: "manual",
    sourceRevision: "0123456789abcdef",
    sourceRevisionVerified: false,
    imageDigest: `sha256:${"a".repeat(64)}`,
    digestSource: "registry",
    requester: "u1",
    approver: null,
    decision: "allow",
    status: "succeeded",
    currentStage: "deploy",
    error: null,
    workDir: "",
    executionMode: "cli",
    deploymentPerformed: true,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...patch,
  };
}

export function makeStage(patch: Partial<StageExecution> = {}): StageExecution {
  return {
    id: "s1",
    deploymentId: "d1",
    sequence: 4,
    attempt: 1,
    stage: "deploy",
    status: "succeeded",
    exitCode: 0,
    startedAt: "2026-10-03T00:00:00.000Z",
    finishedAt: "2026-10-03T00:00:01.000Z",
    artifacts: {},
    summary: null,
    error: null,
    ...patch,
  };
}

export function makeArtifact(patch: Partial<DeploymentArtifact> = {}): DeploymentArtifact {
  return {
    id: "art1",
    deploymentId: "d1",
    stageExecutionId: "s1",
    name: "plan",
    relativePath: "policy/plan.json",
    mediaType: "application/json",
    content: "{}",
    contentHash: "x",
    schemaName: null,
    validationError: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    ...patch,
  };
}

export function makeResult(patch: Partial<DeployResult> = {}): DeployResult {
  return {
    run_id: "d1",
    digest: `sha256:${"a".repeat(64)}`,
    image: "repo@sha256:aaa",
    decision: "activated",
    signature: null,
    targets_planned: ["cloud_run", "onprem"],
    failover_allowed: true,
    targets: [],
    checks: [],
    routing: { result: "ok", kind: "onprem", revision: 1 },
    started_at: "2026-10-03T00:00:00.000Z",
    ...patch,
  };
}
