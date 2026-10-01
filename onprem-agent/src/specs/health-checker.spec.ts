import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpHealthChecker } from "../health-checker.js";
import type { AgentJob, ManagedContainer } from "../types.js";

void test("checks only the candidate loopback origin and configured path", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/ready");
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not start");
    }
    const job = candidateJob();
    const candidate: ManagedContainer = {
      run_id: job.run_id,
      digest: job.digest,
      container: "candidate",
      image: job.image!,
      url: `http://127.0.0.1:${address.port}`,
      host_port: address.port,
      container_port: 8080,
      role: "candidate",
    };
    const result = await new HttpHealthChecker().check(job, candidate);
    assert.equal(result.pass, true);
    assert.equal(result.checks[0]?.status, 204);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function candidateJob(): AgentJob {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    schema_version: 1,
    agent_id: "agent-1",
    job_id: "run-1-candidate-01",
    run_id: "run-1",
    action: "candidate",
    digest,
    image: `registry.example/app@${digest}`,
    plan_hash: "c".repeat(64),
    runtime: { container_port: 8080 },
    health_check: {
      enabled: true,
      path: "/ready",
      method: "GET",
      interval_seconds: 1,
      timeout_seconds: 1,
      success_status_min: 200,
      success_status_max: 299,
      success_threshold: 1,
      failure_threshold: 1,
    },
    created_at: new Date().toISOString(),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    attempt: 1,
    lease_until: new Date(Date.now() + 30_000).toISOString(),
  };
}
