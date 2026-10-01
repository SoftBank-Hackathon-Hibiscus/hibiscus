/**
 * 정책 단계: policy/ 의 stage CLI 를 실제로 부른다.
 *   npm run stage -- --src <앱 소스> --test <test_result.json> --policy <policy.yaml> --out-dir <run>/policy
 *                    --log <run>/decisions.jsonl --source-revision <sha> --json --explain
 * 종료 코드 0 allow / 2 needs_approval / 3 block / 1 오류
 * 성공하면 plan.json 이 contracts/Plan.schema.json 과 맞는지, 지금 run 과 같은 실행·이미지를 가리키는지 확인한다.
 * --handoff 입력(PR #12)이 머지되면 --test 대신 --handoff 로 바꾼다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { npmCommand, parseLastJsonLine } from "../../infrastructure/command-runner.js";
import { contractViolation } from "../contracts.js";
import type { Decision, DeploymentRun } from "../models.js";
import { type StageContext, type StageOutcome, type StageRunner, tail } from "./types.js";

export const POLICY_EXIT_TO_DECISION: Record<number, Decision> = { 0: "allow", 2: "needs_approval", 3: "block" };

const OUT_FILES = ["plan.json", "pii.json", "test_result.json", "migration.json", "explain.ko.md", "explain.ja.md"] as const;

export interface PolicySummary {
  run_id: string;
  source_revision?: string;
  decision: Decision;
  targets: string[];
  failover_allowed: boolean;
  requires: unknown[];
  plan_path: string;
  pii_path: string;
}

/** 서명·배포가 읽는 plan 필드만 */
export interface PlanLike {
  run_id: string;
  digest: string;
  source_revision?: string;
  decision: Decision;
  plan_hash: string;
}

/** plan.json 이 지금 run 과 다른 점. 비어 있으면 같은 실행·같은 이미지 */
export function planMismatches(plan: PlanLike, run: DeploymentRun, decision: Decision, exitCode: number | null): string[] {
  const out: string[] = [];
  if (plan.run_id !== run.run_id) out.push(`plan.run_id=${plan.run_id} 인데 run.run_id=${run.run_id}`);
  if (plan.digest !== run.digest) out.push(`plan.digest=${plan.digest} 인데 run.digest=${run.digest}`);
  if (plan.source_revision !== undefined && plan.source_revision !== run.source_revision) {
    out.push(`plan.source_revision=${plan.source_revision} 인데 run.source_revision=${run.source_revision}`);
  }
  if (plan.decision !== decision) out.push(`plan.decision=${plan.decision} 인데 종료 코드 ${exitCode} 의 decision=${decision}`);
  return out;
}

export function readPlan(policyDir: string): { plan: PlanLike } | { error: string } {
  const planPath = join(policyDir, "plan.json");
  if (!existsSync(planPath)) return { error: `plan.json 이 없음: ${planPath}` };
  try {
    return { plan: JSON.parse(readFileSync(planPath, "utf8")) as PlanLike };
  } catch (e) {
    return { error: `plan.json 을 읽지 못함: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export class PolicyStage implements StageRunner {
  readonly name = "policy" as const;

  async run(ctx: StageContext): Promise<StageOutcome> {
    const { config, runner, app, run, paths } = ctx;
    const testResultPath = join(paths.test, "test_result.json");
    if (!existsSync(testResultPath)) {
      return { status: "failed", artifacts: {}, error: `test_result.json 이 없음: ${testResultPath}` };
    }

    const args = [
      "run",
      "stage",
      "--",
      "--src",
      app.src_path,
      "--test",
      testResultPath,
      "--policy",
      app.policy_path ?? "policy.yaml",
      "--out-dir",
      paths.policy,
      "--log",
      paths.decisionsLog,
      "--source-revision",
      run.source_revision,
      "--json",
      "--explain",
    ];
    const result = await runner.run({ command: npmCommand(), args, cwd: config.policyDir, timeoutMs: config.policyTimeoutMs });

    const artifacts: Record<string, string> = {};
    for (const name of OUT_FILES) {
      const p = join(paths.policy, name);
      if (existsSync(p)) artifacts[name.replace(/\.(json|md)$/, "").replace(".", "_")] = paths.relative(p);
    }
    if (existsSync(paths.decisionsLog)) artifacts.decisions_log = paths.relative(paths.decisionsLog);

    if (result.timedOut) return { status: "failed", exit_code: result.code, artifacts, error: "정책 CLI 시간 초과" };
    const decision = result.code === null ? undefined : POLICY_EXIT_TO_DECISION[result.code];
    if (decision === undefined) {
      return { status: "failed", exit_code: result.code, artifacts, error: `정책 CLI 오류 (종료 코드 ${result.code}): ${tail(result.stderr) || tail(result.stdout)}` };
    }
    const failed = (error: string, summary?: unknown): StageOutcome => ({
      status: "failed",
      exit_code: result.code,
      artifacts,
      ...(summary !== undefined ? { summary } : {}),
      error,
    });

    const summary = parseLastJsonLine(result.stdout) as PolicySummary | undefined;
    if (summary !== undefined && summary.decision !== decision) {
      return failed(`정책 CLI 의 종료 코드(${result.code})와 요약의 decision(${summary.decision})이 다릅니다`, summary);
    }

    // 파트 경계 검증: 계약 형식 → 같은 실행·같은 이미지인지
    const read = readPlan(paths.policy);
    if ("error" in read) return failed(read.error, summary);
    const violation = contractViolation(join(config.contractsDir, "Plan.schema.json"), read.plan, "plan.json");
    if (violation) return failed(violation, summary);
    const mismatches = planMismatches(read.plan, run, decision, result.code);
    if (mismatches.length > 0) return failed(`plan.json 이 지금 run 과 다름: ${mismatches.join("; ")}`, summary);

    return {
      status: "succeeded",
      exit_code: result.code,
      artifacts,
      summary: summary ?? { decision },
      runPatch: { decision },
    };
  }
}
