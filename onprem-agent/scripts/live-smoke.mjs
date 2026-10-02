import { CommandRunner } from "../dist/command-runner.js";
import { DockerRuntime } from "../dist/docker-runtime.js";
import { HttpHealthChecker } from "../dist/health-checker.js";
import { CosignImageVerifier } from "../dist/image-verifier.js";
import { JobExecutor } from "../dist/job-executor.js";
import { StateStore } from "../dist/state-store.js";

const imageA = required("SMOKE_IMAGE_A");
const imageB = required("SMOKE_IMAGE_B");
const publicKey = required("SMOKE_COSIGN_PUBLIC_KEY");
const stateFile = required("SMOKE_STATE_FILE");
const runPrefix = required("SMOKE_RUN_PREFIX");
const planHash = process.env.SMOKE_PLAN_HASH ?? "c".repeat(64);
const config = {
  cosignPublicKey: publicKey,
  stateFile,
  commandTimeoutMs: 300_000,
  dockerStopTimeoutSeconds: 5,
  dockerCommand: "docker",
  cosignCommand: "cosign",
  cosignAllowInsecureRegistry: true,
  cosignInsecureIgnoreTlog: true,
};
const commands = new CommandRunner(config.commandTimeoutMs);
const runtime = new DockerRuntime(config, commands);
const store = new StateStore(stateFile);
const executor = new JobExecutor(
  "smoke-agent",
  store,
  runtime,
  new CosignImageVerifier(config, commands),
  new HttpHealthChecker(),
);

try {
  await executor.restore();
  const candidateA = candidateJob(`${runPrefix}-a`, imageA, planHash);
  const candidateB = candidateJob(`${runPrefix}-b`, imageB, planHash);
  await run(candidateA);
  await run(actionJob(candidateA, "activate"));
  await run(candidateB);
  await run(actionJob(candidateB, "activate"));
  await run({
    ...actionJob(candidateB, "rollback"),
    to_digest: candidateA.digest,
  });
  await run(actionJob(candidateB, "discard"));
  console.log("LIVE_SMOKE_OK");
} finally {
  const state = await store.read();
  for (const container of Object.values(state.containers)) {
    await runtime.remove(container);
  }
}

async function run(job) {
  const result = await executor.execute(job);
  console.log(
    JSON.stringify({
      action: result.action,
      result: result.result,
      candidate: result.candidate,
      previous: result.previous,
      serving: result.serving,
      error: result.error,
    }),
  );
  if (result.result !== "ok") {
    throw new Error(`${result.action} failed: ${result.error}`);
  }
}

function candidateJob(runId, image, planHash) {
  return {
    schema_version: 1,
    agent_id: "smoke-agent",
    job_id: `${runId}-candidate-01`,
    run_id: runId,
    action: "candidate",
    digest: image.slice(image.lastIndexOf("@") + 1),
    image,
    plan_hash: planHash,
    runtime: { container_port: 8080 },
    health_check: {
      enabled: true,
      path: "/healthz",
      method: "GET",
      interval_seconds: 1,
      timeout_seconds: 2,
      success_status_min: 200,
      success_status_max: 299,
      success_threshold: 1,
      failure_threshold: 10,
    },
    created_at: new Date().toISOString(),
    deadline: new Date(Date.now() + 240_000).toISOString(),
    attempt: 1,
    lease_until: new Date(Date.now() + 240_000).toISOString(),
  };
}

function actionJob(candidate, action) {
  return {
    ...candidate,
    job_id: `${candidate.run_id}-${action}-01`,
    action,
    image: undefined,
    plan_hash: undefined,
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
