import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobExecutor } from "../job-executor.js";
import { StateStore } from "../state-store.js";
import type {
  AgentJob,
  ContainerRuntime,
  HealthCheckResult,
  HealthProbe,
  ManagedContainer,
  SignatureVerifier,
} from "../types.js";

class FakeRuntime implements ContainerRuntime {
  createCount = 0;
  removed: string[] = [];

  createCandidate(
    job: AgentJob,
    existing?: ManagedContainer,
  ): Promise<ManagedContainer> {
    this.createCount += 1;
    return Promise.resolve(
      existing ?? {
        run_id: job.run_id,
        digest: job.digest,
        container: `container-${job.digest.at(-1)}`,
        image: job.image!,
        url: `http://127.0.0.1:${18_080 + this.createCount}`,
        host_port: 18_080 + this.createCount,
        container_port: job.runtime.container_port,
        role: "candidate",
      },
    );
  }

  activate(): Promise<void> {
    return Promise.resolve();
  }

  remove(container: ManagedContainer): Promise<void> {
    this.removed.push(container.container);
    return Promise.resolve();
  }

  reconcile(containers: ManagedContainer[]): Promise<ManagedContainer[]> {
    return Promise.resolve(containers);
  }
}

class FakeVerifier implements SignatureVerifier {
  calls = 0;

  verify(): Promise<void> {
    this.calls += 1;
    return Promise.resolve();
  }
}

class PassingHealth implements HealthProbe {
  check(
    job: AgentJob,
    candidate: ManagedContainer,
  ): Promise<HealthCheckResult> {
    return Promise.resolve({
      run_id: job.run_id,
      target: "onprem",
      mode: "candidate",
      pass: true,
      url: candidate.url,
      checks: [{ name: "health", pass: true, ms: 1, status: 200 }],
    });
  }
}

void test("executes each job once and restores candidate lifecycle state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hibiscus-agent-"));
  try {
    const runtime = new FakeRuntime();
    const verifier = new FakeVerifier();
    const store = new StateStore(join(directory, "state.json"));
    const executor = new JobExecutor(
      "agent-1",
      store,
      runtime,
      verifier,
      new PassingHealth(),
    );
    await executor.restore();

    const first = candidateJob("run-1", "a", 1);
    const candidate = await executor.execute(first);
    assert.equal(candidate.result, "ok");
    assert.equal(candidate.candidate?.digest, first.digest);

    const retransmission = await executor.execute({ ...first, attempt: 2 });
    assert.equal(retransmission.attempt, 2);
    assert.equal(runtime.createCount, 1);
    assert.equal(verifier.calls, 1);

    const activated = await executor.execute(actionJob(first, "activate"));
    assert.equal(activated.serving?.digest, first.digest);
    assert.equal((await executor.serving())?.digest, first.digest);

    const second = candidateJob("run-2", "b", 1);
    await executor.execute(second);
    const secondActivation = await executor.execute(
      actionJob(second, "activate"),
    );
    assert.equal(secondActivation.previous?.digest, first.digest);
    assert.equal(secondActivation.serving?.digest, second.digest);

    const rollback = await executor.execute({
      ...actionJob(second, "rollback"),
      to_digest: first.digest,
    });
    assert.equal(rollback.serving?.digest, first.digest);

    const discarded = await executor.execute(actionJob(second, "discard"));
    assert.equal(discarded.result, "ok");
    assert.deepEqual(runtime.removed, ["container-b"]);

    const protectedServing = await executor.execute(
      actionJob(first, "discard"),
    );
    assert.equal(protectedServing.result, "error");
    assert.equal(
      protectedServing.error,
      "Serving container cannot be discarded",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function candidateJob(
  runId: string,
  suffix: string,
  attempt: number,
): AgentJob {
  const digest = `sha256:${suffix.repeat(64)}`;
  return {
    schema_version: 1,
    agent_id: "agent-1",
    job_id: `${runId}-candidate-01`,
    run_id: runId,
    action: "candidate",
    digest,
    image: `registry.example/app@${digest}`,
    plan_hash: "c".repeat(64),
    runtime: { container_port: 8080 },
    health_check: {
      enabled: true,
      path: "/health",
      method: "GET",
      interval_seconds: 1,
      timeout_seconds: 1,
      success_status_min: 200,
      success_status_max: 399,
      success_threshold: 1,
      failure_threshold: 1,
    },
    created_at: new Date().toISOString(),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    attempt,
    lease_until: new Date(Date.now() + 30_000).toISOString(),
  };
}

function actionJob(
  source: AgentJob,
  action: "activate" | "rollback" | "discard",
): AgentJob {
  return {
    ...source,
    job_id: `${source.run_id}-${action}-01`,
    action,
    image: undefined,
    plan_hash: undefined,
  };
}
