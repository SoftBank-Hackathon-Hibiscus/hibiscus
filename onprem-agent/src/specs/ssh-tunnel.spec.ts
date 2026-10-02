import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../config.js";
import { selectSshForwards, sshArguments } from "../ssh-tunnel.js";

void test("creates one restricted SSH connection with multiple reverse forwards", () => {
  const forwards = [
    { target_id: "target-b", gateway_port: 20002, local_port: 32769 },
    { target_id: "target-a", gateway_port: 20001, local_port: 32768 },
  ];
  const selected = selectSshForwards(forwards, new Set([32768, 32769]));
  const args = sshArguments(config(), selected);

  assert.deepEqual(
    args.filter((argument) => argument.startsWith("127.0.0.1:")),
    ["127.0.0.1:20001:127.0.0.1:32768", "127.0.0.1:20002:127.0.0.1:32769"],
  );
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.equal(args.at(-1), "hibiscus-agent@gateway.example.com");
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
    sshKnownHostsFile: "/keys/known_hosts",
    sshCommand: "ssh",
    sshForwardPollIntervalMs: 2_000,
    sshServerAliveIntervalSeconds: 15,
    sshServerAliveCountMax: 3,
  };
}
