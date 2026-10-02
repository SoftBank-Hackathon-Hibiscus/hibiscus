import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../config.js";
import {
  CommandError,
  type CommandExecutor,
  type CommandOutput,
} from "../command-runner.js";
import { DockerRuntime } from "../docker-runtime.js";
import { CosignImageVerifier } from "../image-verifier.js";
import type { AgentJob } from "../types.js";

class FakeCommands implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[] }> = [];

  run(command: string, args: string[]): Promise<CommandOutput> {
    this.calls.push({ command, args });
    if (args[0] === "inspect" && args.includes("{{json .Config.Labels}}")) {
      return Promise.reject(
        new CommandError(
          "docker command failed",
          "Error: No such object: candidate",
          1,
        ),
      );
    }
    if (args[0] === "port") {
      return Promise.resolve({ stdout: "127.0.0.1:32768", stderr: "" });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
}

void test("verifies a signed digest and starts a loopback-only candidate", async () => {
  const commands = new FakeCommands();
  const config = agentConfig();
  const job = candidateJob();
  await new CosignImageVerifier(config, commands).verify(job);
  const candidate = await new DockerRuntime(config, commands).createCandidate(
    job,
  );

  assert.equal(candidate.url, "http://127.0.0.1:32768");
  assert.equal(candidate.container_port, 8080);
  assert.deepEqual(commands.calls[0], {
    command: "cosign",
    args: [
      "verify",
      "--key",
      "/keys/cosign.pub",
      "-a",
      "run_id=run-1",
      "-a",
      `plan_hash=${"c".repeat(64)}`,
      job.image!,
    ],
  });
  const run = commands.calls.find((call) => call.args[0] === "run");
  assert.ok(run);
  assert.ok(run.args.includes("127.0.0.1::8080"));
  assert.ok(run.args.includes("hibiscus.managed=true"));
  assert.equal(run.args.at(-1), job.image);
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
    attempt: 1,
    lease_until: new Date(Date.now() + 30_000).toISOString(),
  };
}

function agentConfig(): AgentConfig {
  return {
    apiUrl: new URL("http://127.0.0.1:8080"),
    agentId: "agent-1",
    token: "x".repeat(32),
    cosignPublicKey: "/keys/cosign.pub",
    stateFile: "/tmp/agent-state.json",
    pollIntervalMs: 2_000,
    heartbeatIntervalMs: 10_000,
    backendRequestTimeoutMs: 10_000,
    commandTimeoutMs: 100_000,
    dockerStopTimeoutSeconds: 10,
    dockerCommand: "docker",
    cosignCommand: "cosign",
    cosignAllowInsecureRegistry: false,
    cosignInsecureIgnoreTlog: false,
    sshHost: "backend.example.com",
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
