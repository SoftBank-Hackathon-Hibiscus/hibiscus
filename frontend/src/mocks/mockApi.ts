// MOCK API. 백엔드 없이 시연할 때 쓰는 가짜 응답. 시간이 지나면 승인 후 진행·failover 가 흘러가게 함
import { ApiError, type Api } from "../api/client";
import type { DeployResult, Plan, RoutingTarget, RoutingTargetHealth } from "../api/types";
import {
  createState,
  healthy,
  IDS,
  ME,
  routingTarget,
  RunBuilder,
  signedLog,
  signResult,
  type MockState,
} from "./scenarios";

let state: MockState = createState();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = <T>(value: T): T => structuredClone(value);
const iso = (ms: number) => new Date(ms).toISOString();

function notFound(what: string): never {
  throw new ApiError(404, `${what} not found`);
}

function advanceApproval(now: number) {
  if (state.approvedAt === null) return;
  const view = state.deployments.get(IDS.ct1);
  if (!view) return;
  const d = view.deployment;
  const elapsed = now - state.approvedAt;
  const run = new RunBuilder(d, 152);
  run.stages = view.stages;
  run.artifacts = view.artifacts;
  run.auditLogs = view.auditLogs;
  const signStage = view.stages.find((stage) => stage.stage === "sign");
  const deployStage = view.stages.find((stage) => stage.stage === "deploy");
  const plan = JSON.parse(view.artifacts.find((artifact) => artifact.name === "plan")!.content) as Plan;

  if (elapsed >= 800 && !signStage) {
    d.status = "running";
    d.updatedAt = iso(now);
    run.stage("sign", "running", {}, { startedAt: iso(now) });
  }
  if (elapsed >= 2500 && signStage?.status === "running") {
    d.updatedAt = iso(now);
    const sign = signResult(d, plan, "contacts", ME.id);
    view.stages.splice(view.stages.indexOf(signStage), 1);
    run.stage("sign", "succeeded", { sign_result: sign }, { startedAt: signStage.startedAt, finishedAt: iso(now), summary: sign }, [
      signedLog(d, sign),
    ]);
    d.currentStage = "deploy";
    run.stage("deploy", "running", {}, { startedAt: iso(now) });
  }
  if (elapsed >= 6000 && deployStage?.status === "running") {
    const target = routingTarget("t-ct1-onprem", IDS.contacts, d.id, "onprem", {
      agentId: IDS.agentContacts,
      localPort: 18091,
      gatewayPort: 20002,
      createdAt: iso(now),
      updatedAt: iso(now),
    });
    const image = `asia-northeast3-docker.pkg.dev/hib-hackathon-1004/hib/contacts@${d.imageDigest}`;
    const result: DeployResult = {
      run_id: d.id,
      digest: d.imageDigest,
      image,
      decision: "activated",
      signature: { verified: true, ref: `cosign:${image}`, key: "signer/keys/cosign.pub", tlog: "verified" },
      targets_planned: ["onprem"],
      failover_allowed: false,
      targets: [
        { target: "onprem", phase: "candidate", result: "ok", job_id: `${d.id}-candidate-01`, container: "contacts-candidate-8c3f5ead", candidate_url: "http://127.0.0.1:18091" },
        { target: "onprem", phase: "activate", result: "ok", job_id: `${d.id}-activate-01`, previous: null, serving: "contacts-8c3f5ead" },
      ],
      checks: [{ target: "onprem", mode: "candidate", pass: true, url: "http://127.0.0.1:18091", checker: "onprem-agent", checks: [] }],
      routing: { result: "ok", target_id: target.id, kind: "onprem", revision: 1 },
      started_at: deployStage.startedAt,
      finished_at: iso(now),
    };
    view.stages.splice(view.stages.indexOf(deployStage), 1);
    run.stage("deploy", "succeeded", { deploy_result: result }, { startedAt: deployStage.startedAt, finishedAt: iso(now) });
    d.status = "succeeded";
    d.deploymentPerformed = true;
    d.updatedAt = iso(now);
    state.targets.push({ target, health: healthy(target, now) });
    state.routes.set(IDS.contacts, { targetId: target.id, revision: 1 });
    const agent = state.agents.get(IDS.agentContacts)!;
    agent.serving = { run_id: d.id, digest: d.imageDigest, container: "contacts-8c3f5ead" };
    state.approvedAt = null;
  }
}

function advanceHealth(now: number) {
  const failedAt = state.onpremFailedAt;
  for (const item of state.targets) {
    const onpremDown = failedAt !== null && item.target.kind === "onprem" && item.target.applicationId === IDS.guestbook;
    if (!onpremDown) {
      item.health = healthy(item.target, now);
      continue;
    }
    // failure_threshold 3 에 닿기 전까지 status 는 이전 값 유지 (routing.service recordHealth 와 같은 규칙)
    const failures = Math.min(3, Math.floor((now - failedAt) / 1000) + 1);
    const health: RoutingTargetHealth = {
      ...(item.health ?? healthy(item.target, now)),
      status: failures >= 3 ? "unhealthy" : "healthy",
      observedAt: iso(now),
      expiresAt: iso(now + 15_000),
      reason: "connect ECONNREFUSED 127.0.0.1:20001",
      failureKind: "network",
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      updatedAt: iso(now),
    };
    item.health = health;
  }

  if (failedAt === null) return;
  const agent = state.agents.get(IDS.agentGuestbook)!;
  if (now - failedAt >= 3000) agent.status = "offline";
  agent.last_seen_at = agent.status === "offline" ? iso(failedAt) : iso(now);

  // health/failover.service.ts 와 같은 조건: 현재 경로가 unhealthy 온프레, 같은 배포의 healthy Cloud Run, failover_allowed
  const route = state.routes.get(IDS.guestbook);
  if (!route || now - failedAt < 4000) return;
  const current = state.targets.find((item) => item.target.id === route.targetId);
  if (!current || current.target.kind !== "onprem" || current.health?.status !== "unhealthy") return;
  const policy = state.deployments.get(current.target.deploymentId)?.policyResult;
  if (!policy?.failoverAllowed) return;
  const fallback = state.targets.find(
    (item) =>
      item.target.enabled &&
      item.target.kind === "cloud_run" &&
      item.target.deploymentId === current.target.deploymentId &&
      item.health?.status === "healthy",
  );
  if (fallback) state.routes.set(IDS.guestbook, { targetId: fallback.target.id, revision: route.revision + 1 });
}

function advance() {
  const now = Date.now();
  advanceApproval(now);
  advanceHealth(now);
  for (const agent of state.agents.values()) {
    if (agent.status === "online") {
      agent.last_seen_at = iso(now - 1500);
      agent.updated_at = agent.last_seen_at;
      agent.received_at = agent.last_seen_at;
    }
  }
}

async function respond<T>(make: () => T): Promise<T> {
  await sleep(120 + Math.random() * 120);
  advance();
  return clone(make());
}

function findTarget(id: string): RoutingTarget {
  return state.targets.find((item) => item.target.id === id)?.target ?? notFound("Routing target");
}

export const mockApi: Api = {
  me: () => respond(() => ME),
  listApplications: () => respond(() => state.applications),
  getApplication: (id) =>
    respond(() => state.applications.find((view) => view.application.id === id) ?? notFound("Application")),
  listDeployments: (id) =>
    respond(() =>
      [...state.deployments.values()]
        .map((view) => view.deployment)
        .filter((d) => d.applicationId === id)
        .sort((a, b) => b.version - a.version),
    ),
  getDeployment: (id) => respond(() => state.deployments.get(id) ?? notFound("Deployment")),
  approve: (id) =>
    respond(() => {
      const view = state.deployments.get(id) ?? notFound("Deployment");
      if (view.deployment.requester === ME.id)
        throw new ApiError(403, "Requester cannot approve their own deployment");
      if (view.deployment.status !== "awaiting_approval")
        throw new ApiError(409, "Deployment is not awaiting approval");
      view.deployment.approver = ME.id;
      view.deployment.status = "queued";
      view.deployment.updatedAt = new Date().toISOString();
      state.approvedAt = Date.now();
      return view.deployment;
    }),
  getRouting: (id) =>
    respond(() => {
      const route = state.routes.get(id);
      if (!route) return null;
      const target = findTarget(route.targetId);
      const health = state.targets.find((item) => item.target.id === target.id)?.health ?? null;
      return { applicationId: id, target, revision: route.revision, health };
    }),
  listTargets: (id) => respond(() => state.targets.filter((item) => item.target.applicationId === id)),
  agentStatus: (id) => respond(() => state.agents.get(id) ?? notFound("Agent")),
};

// 시연 조작. MOCK 모드 화면에서만 노출
export const mockControls = {
  failOnprem() {
    state.onpremFailedAt ??= Date.now();
  },
  reset() {
    state = createState();
  },
  onpremFailing: () => state.onpremFailedAt !== null,
};
