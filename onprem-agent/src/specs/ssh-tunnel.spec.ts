import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AgentConfig } from "../config.js";
import {
  matchesHostKey,
  selectSshForwards,
  sshConnectionConfig,
} from "../ssh-tunnel.js";

void test("selects multiple managed reverse forwards", () => {
  const forwards = [
    { target_id: "target-b", gateway_port: 20002, local_port: 32769 },
    { target_id: "target-a", gateway_port: 20001, local_port: 32768 },
  ];
  const selected = selectSshForwards(forwards, new Set([32768, 32769]));

  assert.deepEqual(selected, [forwards[1], forwards[0]]);
});

void test("builds an ssh2 connection with host key pinning", () => {
  const privateKey = Buffer.from("private-key");
  const connection = sshConnectionConfig(config(), privateKey);

  assert.equal(connection.host, "gateway.example.com");
  assert.equal(connection.username, "hibiscus-agent");
  assert.equal(connection.privateKey, privateKey);
  assert.equal(connection.readyTimeout, 10_000);
  assert.equal(connection.keepaliveInterval, 15_000);
});

void test("accepts only the configured SSH host key", () => {
  const key = Buffer.from("server-host-key");
  const fingerprint = `SHA256:${createHash("sha256")
    .update(key)
    .digest("base64")
    .replace(/=+$/, "")}`;

  assert.equal(matchesHostKey(key, fingerprint), true);
  assert.equal(matchesHostKey(Buffer.from("other-key"), fingerprint), false);
});

void test("rejects forwards to ports not owned by managed containers", () => {
  const selected = selectSshForwards(
    [
      { target_id: "allowed", gateway_port: 20001, local_port: 32768 },
      { target_id: "blocked", gateway_port: 20002, local_port: 22 },
    ],
    new Set([32768]),
  );

  assert.deepEqual(
    selected.map((forward) => forward.target_id),
    ["allowed"],
  );
});

function config(): AgentConfig {
  return {
    apiUrl: new URL("https://backend.example.com"),
    agentId: "agent-1",
    token: "x".repeat(32),
    cosignPublicKey: "/keys/cosign.pub",
    stateFile: "/data/agent-state.json",
    pollIntervalMs: 2_000,
    heartbeatIntervalMs: 10_000,
    backendRequestTimeoutMs: 10_000,
    commandTimeoutMs: 100_000,
    dockerStopTimeoutSeconds: 10,
    dockerCommand: "docker",
    cosignCommand: "cosign",
    cosignAllowInsecureRegistry: false,
    cosignInsecureIgnoreTlog: false,
    sshHost: "gateway.example.com",
    sshPort: 22,
    sshUser: "hibiscus-agent",
    sshIdentityFile: "/keys/agent_ed25519",
    sshHostKeySha256: `SHA256:${"A".repeat(43)}`,
    sshReadyTimeoutMs: 10_000,
    sshForwardPollIntervalMs: 2_000,
    sshServerAliveIntervalSeconds: 15,
    sshServerAliveCountMax: 3,
    sshSessionMaxMs: 900_000,
  };
}

void test("forward changes and elapsed session age preserve the authenticated client", async () => {
  const { SshTunnel } = await import("../ssh-tunnel.js");
  const { StateStore } = await import("../state-store.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const paths = await import("node:path");
  const dir = await mkdtemp(paths.join(tmpdir(), "hibiscus-ssh-"));
  const state = new StateStore(paths.join(dir, "state.json"));
  await state.write({
    schema_version: 1,
    serving_container: "app",
    completed_jobs: {},
    containers: {
      app: {
        run_id: "run",
        digest: "digest",
        container: "app",
        image: "image",
        url: "http://127.0.0.1:3000",
        host_port: 3000,
        container_port: 8080,
        role: "serving",
      },
    },
  });
  const oldForward = {
    target_id: "old",
    gateway_port: 20001,
    local_port: 3000,
  };
  const newForward = {
    target_id: "new",
    gateway_port: 20002,
    local_port: 3000,
  };
  let requested = [newForward];
  const operations: string[] = [];
  const { EventEmitter } = await import("node:events");
  const client = Object.assign(new EventEmitter(), {
    forwardIn: (
      _host: string,
      port: number,
      cb: (error: null, port: number) => void,
    ) => {
      operations.push("add:" + port);
      cb(null, port);
    },
    unforwardIn: (_host: string, port: number, cb: (error: null) => void) => {
      operations.push("remove:" + port);
      cb(null);
    },
    end: () => {
      throw new Error("must not disconnect active channels");
    },
  });
  const tunnel = new SshTunnel(
    config(),
    {
      forwards: async () => requested,
    } as unknown as import("../types.js").BackendAgentClient,
    state,
  );
  const internals = tunnel as unknown as {
    client: unknown;
    connectedAt: number;
    boundForwards: Map<number, import("../types.js").SshForward>;
    reconcile(): Promise<void>;
  };
  internals.client = client;
  internals.connectedAt = Date.now() - 900001;
  internals.boundForwards.set(20001, oldForward);
  try {
    await internals.reconcile();
    assert.equal(internals.client, client);
    assert.deepEqual(operations, ["add:20002", "remove:20001"]);
    requested = [];
    await internals.reconcile();
    assert.equal(internals.client, client);
    assert.deepEqual(operations, ["add:20002", "remove:20001", "remove:20002"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("retry backoff keeps a live session marked connected and reports the next attempt", async () => {
  const { SshTunnel } = await import("../ssh-tunnel.js");
  const { StateStore } = await import("../state-store.js");
  const tunnel = new SshTunnel(
    config(),
    {} as import("../types.js").BackendAgentClient,
    new StateStore("/unused"),
  );
  const internal = tunnel as unknown as {
    client: unknown;
    connectedAt: number;
    failed(error: Error): void;
  };
  internal.client = {};
  internal.connectedAt = Date.now();
  const error = Object.assign(new Error("Control API unavailable"), {
    code: "CONTROL_API_UNAVAILABLE",
  });
  internal.failed(error);
  const report = tunnel.report();
  assert.equal(report.state, "connected");
  assert.equal(report.retry_count, 1);
  assert.equal(report.last_error_code, "CONTROL_API_UNAVAILABLE");
  assert.ok(Date.parse(report.next_retry_at!) > Date.now());
});
