import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../state-store.js";
import { ManagedTunnelTargetAuthorizer } from "../tunnel-target-authorizer.js";
import type { OpenMessage } from "../types.js";

void test("allows only ports owned by managed containers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hibiscus-tunnel-target-"));
  try {
    const store = new StateStore(join(directory, "state.json"));
    await store.write({
      schema_version: 1,
      serving_container: "hibiscus-run-a",
      containers: {
        "hibiscus-run-a": {
          run_id: "run-a",
          digest: `sha256:${"a".repeat(64)}`,
          container: "hibiscus-run-a",
          image: `registry.example/app@sha256:${"a".repeat(64)}`,
          url: "http://127.0.0.1:32768",
          host_port: 32768,
          container_port: 8080,
          role: "serving",
        },
      },
      completed_jobs: {},
    });
    const authorizer = new ManagedTunnelTargetAuthorizer(store);

    assert.equal(await authorizer.authorize(openMessage(32768)), 32768);
    assert.equal(await authorizer.authorize(openMessage(22)), undefined);
    assert.equal(await authorizer.authorize(openMessage(6379)), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function openMessage(localPort: number): OpenMessage {
  return {
    type: "open",
    protocol_version: 1,
    session_id: "session-1",
    channel_id: `channel-${localPort}`,
    target_id: "target-1",
    local_host: "127.0.0.1",
    local_port: localPort,
  };
}
