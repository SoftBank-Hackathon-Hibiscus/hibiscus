/**
 * 보안 단계 실행기: 개인정보 판정 + 정책 결정을 한 번에.
 *
 *   test_result 검증 → policy 로드 → 개인정보 판정(pii.json) → 정책 결정(plan.json) → 결정 기록 한 줄
 *
 * run_id 는 test_result.json 에서 가져와 개인정보 판정에도 같은 값을 쓴다 (R2 입력 불일치가 생기지 않게).
 * source_revision(커밋 SHA)은 --source-revision 옵션이 test_result 의 값보다 우선한다. 둘 다 있는데 다르면 멈춘다.
 * 어느 단계에서 실패했는지 StageError.stage 로 알린다. 엔진과 기존 CLI 의 동작은 그대로 재사용한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadParityHandoff } from "./adapters/load.js";
import { decide, matchedRuleIds } from "./engine.js";
import { LANGS, explainPlan } from "./explainer.js";
import { appendDecisionLog, loadJson, loadPolicy, validate, writeJson } from "./io.js";
import { analyzeMigrations } from "./migration/analyzer.js";
import { filterSince, loadMigrationFiles } from "./migration/loader.js";
import { extract, loadSources } from "./pii/extractor.js";
import { selectClassifier } from "./pii/select.js";
import {
  type Decision,
  type MigrationReport,
  type PiiReport,
  PiiReportSchema,
  type Plan,
  type PlanRequirement,
  SourceRevisionSchema,
  type TestResult,
  TestResultSchema,
} from "./schema.js";

export type StageName = "test_result" | "handoff" | "policy" | "migration" | "pii" | "decide" | "write" | "log";

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
  /** test_result.json 경로. handoffPath 와 둘 중 하나만 */
  testPath?: string;
  /** parity 인계 묶음 경로. 있으면 변환기(src/adapters/parity.ts)로 test_result 를 만든다. testPath 와 둘 중 하나만 */
  handoffPath?: string;
  /** parity 실행 진단 경로 (handoffPath 와 함께만). status 와 digest 를 대조한다 */
  diagnosticsPath?: string;
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
  /** 마이그레이션 판정: 이 이름보다 뒤의 마이그레이션만 검사 */
  since?: string;
  /** true 면 out-dir 에 explain.ko.md, explain.ja.md 를 함께 쓴다 */
  explain?: boolean;
  /**
   * 커밋 SHA (소문자 hex 7~40자). test_result.source_revision 보다 우선한다.
   * test_result 에도 값이 있는데 서로 다르면 실행 오류. "unknown" 은 여기서는 받지 않는다 (형식 오류)
   */
  sourceRevision?: string;
}

export interface StageSummary {
  run_id: string;
  /** 커밋 SHA. plan 에 있을 때만 */
  source_revision?: string;
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
  /** 마이그레이션 판정 결과. facts.migration 이 이미 있었으면 그 값 */
  migration: MigrationReport;
  /** 마이그레이션 판정을 실행기가 채웠는지 (false 면 테스트 파트 값을 존중함) */
  migrationComputed: boolean;
  /** 정책 엔진에 실제로 들어간 test_result (facts.migration 이 채워진 것) */
  test: TestResult;
  /** --explain 으로 쓴 설명 파일 (언어별). 안 썼으면 빈 객체 */
  explainPaths: Partial<Record<(typeof LANGS)[number], string>>;
  /** 판정기 선택 등 사람에게 알릴 것 */
  notes: string[];
  exitCode: number;
}

/**
 * --source-revision 을 test_result 에 반영한다.
 * 옵션이 없으면 test_result 의 값(없거나 "unknown" 이면 없음)을 그대로 쓴다.
 * 옵션이 있으면 형식을 검사하고, test_result 에도 값이 있는데 다르면 에러 (어느 쪽이 맞는지 사람이 봐야 한다).
 */
export function applySourceRevision(test: TestResult, given: string | undefined): TestResult {
  if (given === undefined) return test;
  const parsed = SourceRevisionSchema.safeParse(given);
  if (!parsed.success) throw new Error(`--source-revision 형식 오류: ${given} (${parsed.error.issues[0]?.message ?? "소문자 hex 7~40자"})`);
  if (test.source_revision !== undefined && test.source_revision !== parsed.data) {
    throw new Error(`test_result.source_revision=${test.source_revision} 인데 --source-revision 은 ${parsed.data} 입니다. 어느 쪽이 맞는지 확인하세요`);
  }
  return { ...test, source_revision: parsed.data };
}

async function step<T>(stage: StageName, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError(stage, e instanceof Error ? e.message : String(e));
  }
}

/** --test 또는 --handoff 로 test_result 를 읽는다. 변환기의 경고는 notes 에 더한다 */
function loadTestResult(opts: StageOptions, notes: string[]): TestResult {
  if ((opts.testPath === undefined) === (opts.handoffPath === undefined)) {
    throw new Error("test_result.json(--test) 과 parity 인계 묶음(--handoff) 중 하나만 지정하세요");
  }
  if (opts.handoffPath !== undefined) {
    const { test, warnings } = loadParityHandoff(opts.handoffPath, opts.diagnosticsPath);
    notes.push(...warnings.map((w) => `parity 변환 경고: ${w}`));
    return test;
  }
  if (opts.diagnosticsPath !== undefined) throw new Error("--diagnostics 는 --handoff 와 함께만 쓸 수 있습니다");
  return validate(TestResultSchema, loadJson(opts.testPath!, "test_result"), "test_result", opts.testPath!);
}

export async function runStage(opts: StageOptions): Promise<StageResult> {
  const notes: string[] = [];
  const loaded = await step(opts.handoffPath !== undefined ? "handoff" : "test_result", () =>
    applySourceRevision(loadTestResult(opts, notes), opts.sourceRevision),
  );
  const policy = await step("policy", () => loadPolicy(opts.policyPath));

  const onSkip = (path: string) => notes.push(`symlink 를 건너뜀: ${path}`);

  // 마이그레이션 판정: 실행기가 항상 직접 계산한다. 테스트 파트가 facts.migration 을 줬으면
  // 그 값을 쓰되, destructive 가 우리 계산과 다르면 멈춘다 (어느 쪽이 맞는지 사람이 봐야 한다).
  const existing = loaded.facts.migration;
  const migrationComputed = existing === undefined;
  const computed = await step("migration", () => {
    const { files, sinceFound } = filterSince(loadMigrationFiles(opts.src, onSkip), opts.since);
    if (!sinceFound) {
      throw new Error(`--since 로 준 마이그레이션 이름을 찾을 수 없습니다: ${opts.since} (이름을 확인하세요. 잘못된 이름은 검사 범위를 조용히 바꿉니다)`);
    }
    return analyzeMigrations(files);
  });
  if (existing !== undefined && existing.destructive !== computed.destructive) {
    throw new StageError(
      "migration",
      `test_result.facts.migration.destructive=${existing.destructive} 인데 실행기가 계산한 값은 ${computed.destructive} 입니다. ` +
        `테스트 파트 값: ${JSON.stringify(existing)} / 실행기 값: ${JSON.stringify(computed)}`,
    );
  }
  const migration = existing ?? computed;
  const test: TestResult = migrationComputed ? { ...loaded, facts: { ...loaded.facts, migration } } : loaded;

  const { pii } = await step("pii", async () => {
    const files = loadSources(opts.src, onSkip);
    const candidates = extract(files);
    const { classifier, notes: classifierNotes } = selectClassifier({ mode: opts.classifier, runId: test.run_id, recording: opts.recording });
    const results = await classifier.classify(candidates);
    notes.push(...classifierNotes);
    return { pii: PiiReportSchema.parse({ run_id: test.run_id, pii: results }) };
  });

  const plan = await step("decide", () => decide(test, pii, policy));

  const piiPath = join(opts.outDir, "pii.json");
  const planPath = join(opts.outDir, "plan.json");
  await step("write", () => {
    writeJson(piiPath, pii);
    writeJson(planPath, plan);
    // 정책 엔진에 실제로 들어간 입력. 이걸로 src/cli.ts 를 돌리면 같은 plan_hash 가 나온다
    writeJson(join(opts.outDir, "test_result.json"), test);
    if (migrationComputed) writeJson(join(opts.outDir, "migration.json"), migration);
  });

  const explainPaths: StageResult["explainPaths"] = {};
  if (opts.explain) {
    await step("write", () => {
      mkdirSync(opts.outDir, { recursive: true });
      for (const lang of LANGS) {
        const path = join(opts.outDir, `explain.${lang}.md`);
        writeFileSync(path, explainPlan(plan, { lang, test }), "utf8");
        explainPaths[lang] = resolve(path);
      }
    });
  }

  const logPath = opts.logPath ?? "decisions.jsonl";
  await step("log", () =>
    appendDecisionLog(logPath, {
      kind: "deploy",
      run_id: plan.run_id,
      digest: plan.digest,
      ...(plan.source_revision !== undefined ? { source_revision: plan.source_revision } : {}),
      decision: plan.decision,
      targets: plan.targets,
      rule_ids: matchedRuleIds(plan.rules),
      plan_hash: plan.plan_hash,
    }),
  );

  return {
    summary: {
      run_id: plan.run_id,
      ...(plan.source_revision !== undefined ? { source_revision: plan.source_revision } : {}),
      decision: plan.decision,
      targets: plan.targets,
      failover_allowed: plan.failover_allowed,
      requires: plan.requires ?? [],
      plan_path: resolve(planPath),
      pii_path: resolve(piiPath),
    },
    plan,
    pii,
    migration,
    migrationComputed,
    test,
    explainPaths,
    notes,
    exitCode: EXIT_CODES[plan.decision],
  };
}
