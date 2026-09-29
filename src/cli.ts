/**
 * CLI: 파일 읽기 -> 스키마 검증 -> decide -> plan.json 쓰기 -> decisions.jsonl 에 한 줄 추가
 *
 *   npx tsx src/cli.ts --test test_result.json --pii pii.json --policy policy.yaml --out plan.json
 *   옵션: --log decisions.jsonl (기본값: ./decisions.jsonl)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { decide } from "./engine.js";
import { type DecisionLog, PiiReportSchema, PolicySchema, TestResultSchema } from "./schema.js";

const USAGE = `사용법:
  npx tsx src/cli.ts --test <test_result.json> --pii <pii.json> --policy <policy.yaml> --out <plan.json> [--log <decisions.jsonl>]

옵션:
  --test    테스트 판정 결과 (필수)
  --pii     개인정보 후보 (필수)
  --policy  정책 파일 YAML (필수)
  --out     출력할 배포 계획 경로 (필수)
  --log     결정 기록 파일. 한 줄씩 추가만 한다 (기본: ./decisions.jsonl)
  --help    이 도움말`;

class CliError extends Error {}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = "true";
      continue;
    }
    if (!arg.startsWith("--")) throw new CliError(`알 수 없는 인자: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`${arg} 뒤에 값이 필요합니다`);
    out[arg.slice(2)] = value;
    i++;
  }
  return out;
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new CliError(`${label} 파일을 읽을 수 없습니다: ${path} (${(e as Error).message})`);
  }
}

function loadJson(path: string, label: string): unknown {
  const text = readText(path, label);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${label} 파일이 올바른 JSON 이 아닙니다: ${path} (${(e as Error).message})`);
  }
}

function loadYaml(path: string, label: string): unknown {
  const text = readText(path, label);
  try {
    return parseYaml(text);
  } catch (e) {
    throw new CliError(`${label} 파일이 올바른 YAML 이 아닙니다: ${path} (${(e as Error).message})`);
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown, label: string, path: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join(".") : "(root)";
    return `  - ${where}: ${issue.message}`;
  });
  throw new CliError(`${label} 형식 오류: ${path}\n${lines.join("\n")}`);
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  for (const key of ["test", "pii", "policy", "out"]) {
    if (!args[key]) throw new CliError(`--${key} 옵션이 필요합니다\n\n${USAGE}`);
  }

  const testPath = args.test!;
  const piiPath = args.pii!;
  const policyPath = args.policy!;
  const outPath = args.out!;
  const logPath = args.log ?? "decisions.jsonl";

  const test = validate(TestResultSchema, loadJson(testPath, "test_result"), "test_result", testPath);
  const pii = validate(PiiReportSchema, loadJson(piiPath, "pii"), "pii", piiPath);
  const policy = validate(PolicySchema, loadYaml(policyPath, "policy"), "policy", policyPath);

  const plan = decide(test, pii, policy);

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  // 시간 값은 엔진 밖(여기)에서만 붙인다. 기록은 append 만 하고 기존 줄은 건드리지 않는다.
  const entry: DecisionLog = {
    time: new Date().toISOString(),
    run_id: plan.run_id,
    digest: plan.digest,
    decision: plan.decision,
    targets: plan.targets,
    rule_ids: plan.rules.filter((r) => r.result === "matched").map((r) => r.id),
    plan_hash: plan.plan_hash,
  };
  mkdirSync(dirname(resolve(logPath)), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");

  console.log(`[policy-engine] run_id=${plan.run_id} digest=${plan.digest}`);
  console.log(`  decision : ${plan.decision}`);
  console.log(`  targets  : ${plan.targets.length ? plan.targets.join(", ") : "(none)"}`);
  console.log(`  failover : ${plan.failover_allowed}`);
  if (plan.requires) console.log(`  requires : ${plan.requires.join(", ")}`);
  for (const r of plan.rules) {
    if (r.result === "matched") console.log(`  [${r.id}] ${r.reason}`);
  }
  console.log(`  plan_hash: ${plan.plan_hash}`);
  console.log(`  -> ${outPath} (기록: ${logPath})`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CliError) {
    console.error(`오류: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
