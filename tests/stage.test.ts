import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlanSchema, PiiReportSchema } from "../src/schema.js";
import { EXIT_CODES, StageError, runStage } from "../src/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const POLICY = join(ROOT, "policy.yaml");
const sample = (name: string) => join(ROOT, "samples", name);
const fixtureTest = (name: string) => join(ROOT, "fixtures", name, "test_result.json");

const tempDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-engine-stage-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 실제 CLI 를 자식 프로세스로 실행한다 */
function runCli(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [TSX, join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const stageCli = (args: string[]) => runCli("src/stage.ts", args);

describe("보안 단계 실행기 CLI", () => {
  it("samples/signup-contact + 통과한 test_result → 종료 코드 0, targets [local], pii.json 과 plan.json 생성", () => {
    const out = tmp();
    const r = stageCli(["--src", sample("signup-contact"), "--test", fixtureTest("01-allow"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "decisions.jsonl")]);

    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("decision : allow");
    expect(r.stdout).toContain("targets  : local");

    const pii = PiiReportSchema.parse(JSON.parse(readFileSync(join(out, "pii.json"), "utf8")));
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")));
    expect(pii.run_id).toBe("r-001"); // test_result 의 run_id 를 그대로 쓴다
    expect(pii.pii.map((p) => `${p.table}.${p.column}`)).toEqual(["users.contact"]);
    expect(plan.run_id).toBe("r-001");
    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["local"]);
    expect(plan.failover_allowed).toBe(false);

    const log = readFileSync(join(out, "decisions.jsonl"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!)).toMatchObject({ kind: "deploy", run_id: "r-001", decision: "allow", plan_hash: plan.plan_hash });
  });

  it("samples/ambiguous → needs_approval, 종료 코드 2", () => {
    const out = tmp();
    const r = stageCli(["--src", sample("ambiguous"), "--test", fixtureTest("01-allow"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "decisions.jsonl")]);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stdout).toContain("decision : needs_approval");
    expect(r.stdout).toContain("human_review_pii");
  });

  it("테스트 실패 test_result → block, 종료 코드 3", () => {
    const out = tmp();
    const r = stageCli(["--src", sample("no-pii"), "--test", fixtureTest("02-block-test-failed"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "decisions.jsonl")]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.stdout).toContain("decision : block");
    expect(r.stdout).toContain("fix_tests");
  });

  it("test_result 가 없는 경로 → 종료 코드 1, 단계 이름이 포함된 에러", () => {
    const out = tmp();
    const r = stageCli(["--src", sample("no-pii"), "--test", join(out, "nope.json"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "decisions.jsonl")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("[단계: test_result]");
    expect(r.stderr).toContain("nope.json");
    expect(existsSync(join(out, "plan.json"))).toBe(false);
  });

  it("앱 폴더가 없으면 pii 단계에서 실패, 정책이 깨지면 policy 단계에서 실패", () => {
    const out = tmp();
    const noSrc = stageCli(["--src", join(out, "missing-app"), "--test", fixtureTest("01-allow"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "decisions.jsonl")]);
    expect(noSrc.code).toBe(1);
    expect(noSrc.stderr).toContain("[단계: pii]");

    const badPolicy = stageCli(["--src", sample("no-pii"), "--test", fixtureTest("01-allow"), "--policy", join(ROOT, "package.json"), "--out-dir", out, "--log", join(out, "decisions.jsonl")]);
    expect(badPolicy.code).toBe(1);
    expect(badPolicy.stderr).toContain("[단계: policy]");
  });

  it("필수 옵션이 빠지면 종료 코드 1 과 사용법", () => {
    const r = stageCli(["--src", sample("no-pii")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--test");
  });

  it("--json 이면 stdout 에 한 줄 JSON 요약만 나온다", () => {
    const out = tmp();
    const r = stageCli(["--src", sample("signup-contact"), "--test", fixtureTest("01-allow"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "decisions.jsonl"), "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const summary = JSON.parse(lines[0]!);
    expect(Object.keys(summary).sort()).toEqual(["decision", "failover_allowed", "pii_path", "plan_path", "requires", "run_id", "targets"]);
    expect(summary).toMatchObject({ run_id: "r-001", decision: "allow", targets: ["local"], failover_allowed: false, requires: [] });
    expect(existsSync(summary.plan_path)).toBe(true);
    expect(existsSync(summary.pii_path)).toBe(true);
  });
});

describe("runStage (라이브러리)", () => {
  it("같은 입력을 두 번 → 같은 plan_hash", async () => {
    const a = tmp();
    const b = tmp();
    const opts = (outDir: string) => ({ src: sample("signup-contact"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir, logPath: join(outDir, "d.jsonl") });
    const first = await runStage(opts(a));
    const second = await runStage(opts(b));
    expect(first.plan.plan_hash).toBe(second.plan.plan_hash);
    expect(first.plan).toEqual(second.plan);
    expect(first.pii).toEqual(second.pii);
    expect(first.exitCode).toBe(EXIT_CODES.allow);
  });

  it("따로 실행한 두 CLI(pii → 정책)의 결과와 stage 의 결과가 같다", async () => {
    const separate = tmp();
    const staged = tmp();

    // 1) 개인정보 판정 CLI
    const piiPath = join(separate, "pii.json");
    const p = runCli("src/pii/cli.ts", ["--src", sample("signup-contact"), "--run-id", "r-001", "--out", piiPath]);
    expect(p.code, p.stderr).toBe(0);
    // 2) 정책 엔진 CLI
    const planPath = join(separate, "plan.json");
    const d = runCli("src/cli.ts", ["--test", fixtureTest("01-allow"), "--pii", piiPath, "--policy", POLICY, "--out", planPath, "--log", join(separate, "d.jsonl")]);
    expect(d.code, d.stderr).toBe(0);

    // 3) stage
    const result = await runStage({ src: sample("signup-contact"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir: staged, logPath: join(staged, "d.jsonl") });

    expect(JSON.parse(readFileSync(join(staged, "pii.json"), "utf8"))).toEqual(JSON.parse(readFileSync(piiPath, "utf8")));
    expect(JSON.parse(readFileSync(join(staged, "plan.json"), "utf8"))).toEqual(JSON.parse(readFileSync(planPath, "utf8")));
    expect(result.plan.plan_hash).toBe(JSON.parse(readFileSync(planPath, "utf8")).plan_hash);
  });

  it("실패한 단계를 StageError.stage 로 알린다", async () => {
    const out = tmp();
    await expect(runStage({ src: sample("no-pii"), testPath: join(out, "nope.json"), policyPath: POLICY, outDir: out })).rejects.toMatchObject({ stage: "test_result" });
    await expect(runStage({ src: sample("no-pii"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir: out, classifier: "gpt" })).rejects.toBeInstanceOf(StageError);
    await expect(runStage({ src: sample("no-pii"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir: out, classifier: "gpt" })).rejects.toMatchObject({ stage: "pii" });
  });

  it("replay 판정기도 고를 수 있다", async () => {
    const out = tmp();
    const result = await runStage({
      src: sample("ambiguous"),
      testPath: fixtureTest("01-allow"),
      policyPath: POLICY,
      outDir: out,
      classifier: "replay",
      recording: join(ROOT, "recordings", "ambiguous.json"),
      logPath: join(out, "d.jsonl"),
    });
    expect(result.pii.pii[0]).toMatchObject({ column: "emergency_no", confident: true, source: "replay" });
    expect(result.summary.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
  });
});
