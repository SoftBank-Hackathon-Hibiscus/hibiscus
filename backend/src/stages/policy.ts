/**
 * 정책 단계: policy/ 의 stage CLI 를 실제로 부른다.
 *   npm run stage -- --src <앱 소스> --test <test_result.json> --policy <policy.yaml> --out-dir <run>/policy
 *                    --log <run>/decisions.jsonl --source-revision <sha> --json --explain
 * 종료 코드 0 allow / 2 needs_approval / 3 block / 1 오류
 * --handoff 입력(PR #12)이 머지되면 --test 대신 --handoff 로 바꾼다.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { npmCommand, parseLastJsonLine } from "../command-runner.js";
import type { Decision } from "../models.js";
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

    const summary = parseLastJsonLine(result.stdout) as PolicySummary | undefined;
    if (summary !== undefined && summary.decision !== decision) {
      return {
        status: "failed",
        exit_code: result.code,
        artifacts,
        summary,
        error: `정책 CLI 의 종료 코드(${result.code})와 요약의 decision(${summary.decision})이 다릅니다`,
      };
    }
    if (!existsSync(join(paths.policy, "plan.json"))) {
      return { status: "failed", exit_code: result.code, artifacts, summary, error: "정책 CLI 가 plan.json 을 남기지 않음" };
    }

    return {
      status: "succeeded",
      exit_code: result.code,
      artifacts,
      summary: summary ?? { decision },
      runPatch: { decision },
    };
  }
}
