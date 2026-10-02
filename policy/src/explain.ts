/**
 * CLI: 결정서 → 사람이 읽는 Markdown 설명
 *
 *   npx tsx src/explain.ts --plan plan.json [--test test_result.json] [--rollback] [--lang ko|ja] [--out explain.md]
 *
 * --out 이 없으면 stdout 에 출력한다. --test 를 주고 facts.conditions 가 있으면 조건별 재생 결과 줄이 들어간다.
 */
import { CliError, loadJson, parseArgs, requireArgs, runCli, validate } from "./io.js";
import { LANGS, explainPlan, explainRollbackPlan, isLang } from "./explainer.js";
import { PlanSchema, RollbackPlanSchema, TestResultSchema } from "./schema.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const USAGE = `사용법:
  npx tsx src/explain.ts --plan <plan.json> [--test <test_result.json>] [--rollback] [--lang ko|ja] [--out <explain.md>]

옵션:
  --plan      설명할 결정서 (plan.json, 또는 --rollback 이면 rollback_plan.json) (필수)
  --test      결정에 들어간 test_result.json (배포 결정서만). facts.conditions 가 있으면 조건별 재생 결과 줄을 넣는다
  --rollback  입력이 롤백 결정서(rollback_plan.json)임을 표시
  --lang      ko (기본) | ja
  --out       파일로 저장. 없으면 stdout 에 출력
  --help      이 도움말`;

const FLAGS = new Set(["rollback"]);

runCli(() => {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["plan"], USAGE);
  const planPath = args.plan!;
  const lang = args.lang ?? "ko";
  if (!isLang(lang)) throw new CliError(`--lang 은 ${LANGS.join(" | ")} 중 하나여야 합니다: ${lang}`);

  if (args.rollback && args.test) throw new CliError("--test 는 배포 결정서(plan.json)에만 쓸 수 있습니다");
  const data = loadJson(planPath, args.rollback ? "rollback_plan" : "plan");
  const test = args.test !== undefined ? validate(TestResultSchema, loadJson(args.test, "test_result"), "test_result", args.test) : undefined;
  const markdown = args.rollback
    ? explainRollbackPlan(validate(RollbackPlanSchema, data, "rollback_plan", planPath), { lang })
    : explainPlan(validate(PlanSchema, data, "plan", planPath), { lang, test });

  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, markdown, "utf8");
    console.log(`-> ${args.out}`);
  } else {
    process.stdout.write(markdown);
  }
  return 0;
});
