/** 테스트 도우미: 가짜 명령 실행기와 서비스 조립 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { buildService } from "../src/bootstrap/build.js";
import { BACKEND_ROOT, loadConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/infrastructure/command-runner.js";
import type { Decision } from "../src/pipeline/models.js";
import type { PipelineService } from "../src/pipeline/service.js";

export type Handler = (spec: CommandSpec) => CommandResult | undefined | Promise<CommandResult | undefined>;

export const ok = (stdout = "", stderr = ""): CommandResult => ({ code: 0, signal: null, stdout, stderr, timedOut: false });
export const exit = (code: number, stdout = "", stderr = ""): CommandResult => ({ code, signal: null, stdout, stderr, timedOut: false });

export function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];

  constructor(private readonly handlers: Handler[]) {}

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    for (const h of this.handlers) {
      const r = await h(spec);
      if (r) return r;
    }
    throw new Error(`가짜 실행기에 처리기가 없음: ${spec.command} ${spec.args.join(" ")}`);
  }

  /** npm run <script> 호출만 골라낸다 */
  npmCalls(script: string): CommandSpec[] {
    return this.calls.filter((c) => /^npm(\.cmd)?$/.test(c.command) && c.args[1] === script);
  }
}

export const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** git rev-parse HEAD / git status 를 흉내 낸다. head 가 없으면 git 저장소가 아닌 것으로 */
export function gitHandler(opts: { head?: string; dirty?: boolean } = {}): Handler {
  const head = "head" in opts ? opts.head : HEAD;
  return (spec) => {
    if (spec.command !== "git") return undefined;
    if (spec.args[0] === "rev-parse") return head ? ok(`${head}\n`) : exit(128, "", "fatal: not a git repository");
    if (spec.args[0] === "status") return ok(opts.dirty ? " M app.py\n" : "");
    return undefined;
  };
}

const PLAN_HASH = "29aec1d7f9c41033e11039df831557032cf5dbc900be084f318b014bb0efc92e";
const EXIT_OF: Record<Decision, number> = { allow: 0, needs_approval: 2, block: 3 };

/**
 * policy stage CLI 를 흉내 낸다: plan.json 과 decisions.jsonl 을 쓰고 종료 코드로 결정을 알린다.
 * plan 에 override 를 주면 그 값으로 덮어써 "다른 실행의 plan" 을 흉내 낼 수 있다.
 */
export function policyHandler(result: Decision | { error: string }, override: { plan?: Record<string, unknown> } = {}): Handler {
  return (spec) => {
    if (!/^npm(\.cmd)?$/.test(spec.command) || spec.args[1] !== "stage") return undefined;
    const echo = "> policy-engine@0.1.0 stage\n> tsx src/stage.ts ...\n\n";
    if (typeof result !== "string") return exit(1, echo, `오류 [단계: test_result] ${result.error}\n`);

    const test = JSON.parse(readFileSync(argValue(spec.args, "--test")!, "utf8")) as Record<string, unknown>;
    const outDir = argValue(spec.args, "--out-dir")!;
    const sourceRevision = argValue(spec.args, "--source-revision");
    const targets = result === "block" ? [] : ["onprem", "cloud_run"];
    const plan = {
      run_id: test.run_id,
      app: test.app,
      digest: test.digest,
      ...(sourceRevision ? { source_revision: sourceRevision } : {}),
      decision: result,
      targets,
      failover_allowed: result === "allow",
      requires: result === "needs_approval" ? [{ id: "human_review_pii", rule_id: "R3", allowed_targets: targets }] : [],
      rules: [],
      plan_hash: PLAN_HASH,
      ...override.plan,
    };
    const planPath = join(outDir, "plan.json");
    writeJson(planPath, plan);
    writeJson(join(outDir, "pii.json"), { run_id: test.run_id, pii: [] });
    writeJson(join(outDir, "test_result.json"), test);
    const log = argValue(spec.args, "--log")!;
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, JSON.stringify({ kind: "deploy", time: new Date().toISOString(), run_id: test.run_id, digest: test.digest, decision: result, targets, rule_ids: [], plan_hash: PLAN_HASH }) + "\n");
    const summary = {
      run_id: test.run_id,
      ...(sourceRevision ? { source_revision: sourceRevision } : {}),
      decision: result,
      targets,
      failover_allowed: plan.failover_allowed,
      requires: plan.requires,
      plan_path: planPath,
      pii_path: join(outDir, "pii.json"),
    };
    return exit(EXIT_OF[result], echo + JSON.stringify(summary) + "\n");
  };
}

/** signer approve / sign 을 흉내 낸다. signResult 에 override 를 주면 sign_result.json 의 그 값을 덮어쓴다 */
export function signerHandler(override: { signResult?: Record<string, unknown> } = {}): Handler {
  return (spec) => {
    if (!/^npm(\.cmd)?$/.test(spec.command)) return undefined;
    const script = spec.args[1];
    if (script !== "approve" && script !== "sign") return undefined;
    const plan = JSON.parse(readFileSync(argValue(spec.args, "--plan")!, "utf8")) as Record<string, unknown>;
    const requester = argValue(spec.args, "--requester")!;

    if (script === "approve") {
      const approver = argValue(spec.args, "--approver")!;
      if (plan.decision !== "needs_approval") return exit(2, "", "[signer] 오류 APPROVAL_NOT_NEEDED");
      if (approver === requester) return exit(2, "", "[signer] 오류 SELF_APPROVAL");
      writeJson(argValue(spec.args, "--out")!, { run_id: plan.run_id, digest: plan.digest, plan_hash: plan.plan_hash, plan_sha256: "0".repeat(64), requester, approver, approved_at: new Date().toISOString() });
      return ok("[signer] 승인 기록 저장\n");
    }

    const out = argValue(spec.args, "--out")!;
    const log = argValue(spec.args, "--log")!;
    const repo = argValue(spec.args, "--image-repo")!;
    const approvalPath = argValue(spec.args, "--approval");
    const base = { run_id: plan.run_id, digest: plan.digest, plan_hash: plan.plan_hash, requester };
    const refuse = (reason: string) => {
      appendFileSync(log, JSON.stringify({ kind: "sign", time: new Date().toISOString(), ...base, result: "refused", approver: null, reason, signature_ref: null }) + "\n");
      return exit(1, "", `[signer] 서명 안 함 (${reason})`);
    };
    if (plan.decision === "block") return refuse("policy_block");
    let approver = "auto";
    if (plan.decision === "needs_approval") {
      if (!approvalPath || !existsSync(approvalPath)) return refuse("approval_missing");
      approver = (JSON.parse(readFileSync(approvalPath, "utf8")) as { approver: string }).approver;
    }
    const signatureRef = `${spec.args.includes("--dry-run") ? "dry-run" : "cosign"}:${repo}@${plan.digest}`;
    writeJson(out, { ...base, targets: plan.targets, failover_allowed: plan.failover_allowed, approver, signature_ref: signatureRef, signed_at: new Date().toISOString(), ...override.signResult });
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, JSON.stringify({ kind: "sign", time: new Date().toISOString(), ...base, result: "signed", approver, reason: null, signature_ref: signatureRef }) + "\n");
    return ok(`[signer] 서명함 run_id=${plan.run_id}\n`);
  };
}

export interface Harness {
  workDir: string;
  runner: FakeCommandRunner;
  service: PipelineService;
  app: Hono;
}

export function makeHarness(handlers: Handler[], env: NodeJS.ProcessEnv = {}): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "hibiscus-backend-"));
  const config = loadConfig({ WORK_DIR: workDir, SIGNER_MODE: "dry", DEPLOY_MODE: "off", ...env }, BACKEND_ROOT);
  const runner = new FakeCommandRunner(handlers);
  const service = buildService(config, { runner });
  return { workDir, runner, service, app: createApp(service) };
}

export async function post(app: Hono, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

export async function get(app: Hono, path: string): Promise<{ status: number; json: any }> {
  const res = await app.request(path);
  return { status: res.status, json: await res.json() };
}

export const APP_INPUT = { name: "guestbook", src_path: "sample-app", image_repo: "asia-northeast3-docker.pkg.dev/hib/apps/guestbook" };
export const REGISTRY_DIGEST = "sha256:a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990aabbccddeeff";

/** 앱을 만들고 run 을 시작한 뒤 끝날 때까지 기다린다 */
export async function runOnce(h: Harness, runBody: Record<string, unknown> = { requester: "ryu" }, appBody: Record<string, unknown> = APP_INPUT) {
  const created = await post(h.app, "/apps", appBody);
  if (created.status !== 201) throw new Error(`앱 생성 실패: ${JSON.stringify(created.json)}`);
  const started = await post(h.app, `/apps/${created.json.id}/runs`, runBody);
  if (started.status !== 202) return { appId: created.json.id as string, started, view: undefined };
  await h.service.waitFor(started.json.run_id);
  const view = await get(h.app, `/runs/${started.json.run_id}`);
  return { appId: created.json.id as string, started, view: view.json as { run: any; stages: any[] } };
}

export function stageOf(view: { stages: any[] }, name: string) {
  return view.stages.find((s) => s.stage === name);
}
