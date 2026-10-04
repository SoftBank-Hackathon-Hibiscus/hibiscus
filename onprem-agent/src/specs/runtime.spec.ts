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
import type { AgentJob, ManagedContainer } from "../types.js";

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
  const candidate = await new DockerRuntime(config, commands, async () => 32768).createCandidate(
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
  assert.ok(run.args.includes("127.0.0.1:32768:8080"));
  assert.ok(run.args.includes("hibiscus.managed=true"));
  assert.deepEqual(
    run.args.slice(run.args.indexOf("--env"), run.args.indexOf("--env") + 2),
    ["--env", "DATABASE_URL=postgres://shared.example/app"],
  );
  assert.equal(run.args.at(-1), job.image);
});

void test("recreates a missing serving container on its saved host port", async () => {
  const commands = new FakeCommands();
  const container = managedContainer("serving");

  const recovered = await new DockerRuntime(
    agentConfig(),
    commands,
  ).reconcile([container], container.container);

  assert.deepEqual(recovered, [container]);
  const run = commands.calls.find((call) => call.args[0] === "run");
  assert.ok(run);
  assert.ok(run.args.includes("127.0.0.1:32768:8080"));
  assert.equal(run.args[run.args.indexOf("--restart") + 1], "unless-stopped");
  assert.equal(run.args.at(-1), container.image);
});

void test("does not recreate a missing non-serving container", async () => {
  const commands = new FakeCommands();
  const container = managedContainer("standby");

  const recovered = await new DockerRuntime(
    agentConfig(),
    commands,
  ).reconcile([container], null);

  assert.deepEqual(recovered, []);
  assert.equal(commands.calls.some((call) => call.args[0] === "run"), false);
});

void test("rejects a changed port after Docker restart", async () => {
  const container = managedContainer("serving");
  const commands: CommandExecutor = {
    async run(_command, args) {
      if (args.includes("{{json .Config.Labels}}")) return {stdout: JSON.stringify({"hibiscus.managed": "true", "hibiscus.digest": container.digest}), stderr: ""};
      if (args[0] === "port") return {stdout: "127.0.0.1:32769", stderr: ""};
      return {stdout: "true", stderr: ""};
    },
  };
  await assert.rejects(new DockerRuntime(agentConfig(), commands).reconcile([container], container.container), /expected 32768, actual 32769/);
});

void test("rejects a dynamic binding even when the current port matches", async () => {
  const container = managedContainer("serving");
  const commands: CommandExecutor = {
    async run(_command, args) {
      if (args.includes("{{json .Config.Labels}}")) return {stdout: JSON.stringify({"hibiscus.managed": "true", "hibiscus.digest": container.digest}), stderr: ""};
      if (args.includes("{{json .HostConfig.PortBindings}}")) return {stdout: JSON.stringify({"8080/tcp": [{HostIp: "127.0.0.1", HostPort: ""}]}), stderr: ""};
      if (args[0] === "port") return {stdout: "127.0.0.1:32768", stderr: ""};
      return {stdout: "true", stderr: ""};
    },
  };
  await assert.rejects(new DockerRuntime(agentConfig(), commands).reconcile([container], container.container), /fixed loopback binding/);
});

void test("keeps the saved port when recreating a missing candidate", async () => {
  const commands = new FakeCommands();
  const existing = managedContainer("candidate");
  await new DockerRuntime(agentConfig(), commands, async () => 40000).createCandidate(candidateJob(), existing);
  assert.ok(commands.calls.find(c => c.args[0] === "run")?.args.includes("127.0.0.1:32768:8080"));
});

void test("reports a fixed-port collision without retrying on another port", async () => {
  const commands = new FakeCommands();
  const run = commands.run.bind(commands);
  commands.run = (command, args) => args[0] === "run"
    ? Promise.reject(new CommandError("docker command failed", "port is already allocated", 1))
    : run(command, args);
  let allocations = 0;
  await assert.rejects(new DockerRuntime(agentConfig(), commands, async () => {
    allocations++;
    return 32768;
  }).createCandidate(candidateJob()), /docker command failed/);
  assert.equal(allocations, 1);
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
    runtime: {
      container_port: 8080,
      environment: { DATABASE_URL: "postgres://shared.example/app" },
    },
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

function managedContainer(role: ManagedContainer["role"]): ManagedContainer {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    run_id: "run-1",
    digest,
    container: "candidate",
    image: `registry.example/app@${digest}`,
    url: "http://127.0.0.1:32768",
    host_port: 32768,
    container_port: 8080,
    role,
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
    sshHostKeySha256: `SHA256:${"A".repeat(43)}`,
    sshReadyTimeoutMs: 10_000,
    sshForwardPollIntervalMs: 2_000,
    sshServerAliveIntervalSeconds: 15,
    sshServerAliveCountMax: 3,
    sshSessionMaxMs: 900_000,
  };
}
