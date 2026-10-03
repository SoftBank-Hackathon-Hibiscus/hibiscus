import { BackendClient } from "./backend-client.js";
import { CommandRunner } from "./command-runner.js";
import { loadConfig } from "./config.js";
import { DockerRuntime } from "./docker-runtime.js";
import { HttpHealthChecker } from "./health-checker.js";
import { CosignImageVerifier } from "./image-verifier.js";
import { JobExecutor } from "./job-executor.js";
import { JobRunner } from "./job-runner.js";
import { StateStore } from "./state-store.js";
import { SshTunnel } from "./ssh-tunnel.js";
import { SshIdentity } from "./ssh-identity.js";

import { RuntimeLogCollector } from "./runtime-log-collector.js";

const config = loadConfig();
const commands = new CommandRunner(config.commandTimeoutMs);
const backend = new BackendClient(config);
await new SshIdentity(config, backend).ensure();
const state = new StateStore(config.stateFile);
const executor = new JobExecutor(
  config.agentId,
  state,
  new DockerRuntime(config, commands),
  new CosignImageVerifier(config, commands),
  new HttpHealthChecker(),
);
const jobs = new JobRunner(config, backend, executor);
const tunnel = new SshTunnel(config, backend, state);

const logs = new RuntimeLogCollector(config, commands, state, backend);

const stop = () => {
  jobs.stop();
  logs.stop();
  tunnel.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await Promise.all([jobs.start(), tunnel.start(), logs.start()]);
} catch (error) {
  stop();
  console.error(
    `[onprem-agent] stopped: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
}
