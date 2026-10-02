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
