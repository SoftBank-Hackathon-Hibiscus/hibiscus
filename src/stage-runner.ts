/**
 * 보안 단계 실행기: 개인정보 판정 + 정책 결정을 한 번에.
 *
 *   test_result 검증 → policy 로드 → 개인정보 판정(pii.json) → 정책 결정(plan.json) → 결정 기록 한 줄
 *
 * run_id 는 test_result.json 에서 가져와 개인정보 판정에도 같은 값을 쓴다 (R2 입력 불일치가 생기지 않게).
 * 어느 단계에서 실패했는지 StageError.stage 로 알린다. 엔진과 기존 CLI 의 동작은 그대로 재사용한다.
 */
import { join, resolve } from "node:path";
import { decide } from "./engine.js";
import { appendDecisionLog, loadJson, loadPolicy, validate, writeJson } from "./io.js";
import { extract, loadSources } from "./pii/extractor.js";
import { selectClassifier } from "./pii/select.js";
import { type Decision, type PiiReport, PiiReportSchema, type Plan, type PlanRequirement, TestResultSchema } from "./schema.js";

export type StageName = "test_result" | "policy" | "pii" | "decide" | "write" | "log";

export class StageError extends Error {
  constructor(
    readonly stage: StageName,
    message: string,
  ) {
    super(message);
  }
}

/** 결정별 종료 코드. 실행 오류는 1 */
export const EXIT_CODES: Record<Decision, number> = { allow: 0, needs_approval: 2, block: 3 };
export const EXIT_ERROR = 1;

export interface StageOptions {
  /** 분석할 앱 소스 폴더 */
  src: string;
  /** test_result.json 경로 */
  testPath: string;
  /** policy.yaml 경로 */
  policyPath: string;
  /** pii.json, plan.json 을 쓸 폴더 */
  outDir: string;
  /** heuristic (기본) | llm | replay */
  classifier?: string;
  /** replay 용 녹화 파일 */
  recording?: string;
  /** 결정 기록 파일. 기본 ./decisions.jsonl */
  logPath?: string;
}

export interface StageSummary {
  run_id: string;
  decision: Decision;
  targets: string[];
  failover_allowed: boolean;
  requires: PlanRequirement[];
  plan_path: string;
  pii_path: string;
}

export interface StageResult {
  summary: StageSummary;
  plan: Plan;
  pii: PiiReport;
  /** 판정기 선택 등 사람에게 알릴 것 */
  notes: string[];
  exitCode: number;
}

async function step<T>(stage: StageName, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError(stage, e instanceof Error ? e.message : String(e));
  }
}

export async function runStage(opts: StageOptions): Promise<StageResult> {
  const test = await step("test_result", () => validate(TestResultSchema, loadJson(opts.testPath, "test_result"), "test_result", opts.testPath));
  const policy = await step("policy", () => loadPolicy(opts.policyPath));

  const { pii, notes } = await step("pii", async () => {
    const files = loadSources(opts.src);
    const candidates = extract(files);
    const { classifier, notes } = selectClassifier({ mode: opts.classifier, runId: test.run_id, recording: opts.recording });
    const results = await classifier.classify(candidates);
    return { pii: PiiReportSchema.parse({ run_id: test.run_id, pii: results }), notes };
  });

  const plan = await step("decide", () => decide(test, pii, policy));

  const piiPath = join(opts.outDir, "pii.json");
  const planPath = join(opts.outDir, "plan.json");
  await step("write", () => {
    writeJson(piiPath, pii);
    writeJson(planPath, plan);
  });

  const logPath = opts.logPath ?? "decisions.jsonl";
  await step("log", () =>
    appendDecisionLog(logPath, {
      kind: "deploy",
      run_id: plan.run_id,
      digest: plan.digest,
      decision: plan.decision,
      targets: plan.targets,
      rule_ids: plan.rules.filter((r) => r.result !== "not_matched").map((r) => r.id),
      plan_hash: plan.plan_hash,
    }),
  );

  return {
    summary: {
      run_id: plan.run_id,
      decision: plan.decision,
      targets: plan.targets,
      failover_allowed: plan.failover_allowed,
      requires: plan.requires ?? [],
      plan_path: resolve(planPath),
      pii_path: resolve(piiPath),
    },
    plan,
    pii,
    notes,
    exitCode: EXIT_CODES[plan.decision],
  };
}
