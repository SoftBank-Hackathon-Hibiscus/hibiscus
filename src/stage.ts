/**
 * CLI: 보안 단계 실행기 (개인정보 판정 + 정책 결정)
 *
 *   npx tsx src/stage.ts --src <앱 폴더> --test <test_result.json> --policy policy.yaml --out-dir <폴더> [--classifier heuristic|llm|replay] [--json]
 *
 * 종료 코드: allow 0, needs_approval 2, block 3, 실행 오류 1
 */
import { CliError, parseArgs, requireArgs } from "./io.js";
import { EXIT_ERROR, StageError, runStage } from "./stage-runner.js";

const USAGE = `사용법:
  npx tsx src/stage.ts --src <앱 폴더> --test <test_result.json> --policy <policy.yaml> --out-dir <폴더> [옵션]

옵션:
  --classifier  heuristic (기본) | llm | replay
  --recording   replay 용 녹화 파일 (기본 recordings/<run_id>.json)
  --since       마이그레이션 판정: 이 이름보다 뒤의 마이그레이션만 검사
  --log         결정 기록 파일 (기본 ./decisions.jsonl)
  --explain     out-dir 에 사람이 읽는 설명 explain.ko.md, explain.ja.md 를 함께 쓴다
  --json        사람이 읽는 출력 대신 한 줄 JSON 요약을 stdout 에 출력
  --help        이 도움말

종료 코드: allow 0, needs_approval 2, block 3, 실행 오류 1
out-dir 에 pii.json, plan.json, 정책에 실제로 들어간 test_result.json 을 쓴다.
test_result 의 facts.migration 이 없으면 마이그레이션 판정을 돌려 채우고 migration.json 도 쓴다.
run_id 는 test_result.json 의 값을 쓴다.`;

const FLAGS = new Set(["json", "explain"]);

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, FLAGS);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["src", "test", "policy", "out-dir"], USAGE);
  const json = args.json === "true";

  const result = await runStage({
    src: args.src!,
    testPath: args.test!,
    policyPath: args.policy!,
    outDir: args["out-dir"]!,
    classifier: args.classifier,
    recording: args.recording,
    logPath: args.log,
    since: args.since,
    explain: args.explain === "true",
  });

  if (json) {
    for (const n of result.notes) console.error(`! ${n}`);
    console.log(JSON.stringify(result.summary));
    return result.exitCode;
  }

  const { summary, plan } = result;
  console.log(`[stage] run_id=${summary.run_id} digest=${plan.digest}`);
  for (const n of result.notes) console.log(`  ! ${n}`);
  console.log(`  pii      : ${result.pii.pii.length}건 -> ${summary.pii_path}`);
  for (const p of result.pii.pii) console.log(`    - ${p.table}.${p.column} ${p.kind} confident=${p.confident} ${p.evidence}`);
  console.log(`  migration: destructive=${result.migration.destructive} (${result.migrationComputed ? "실행기가 판정" : "test_result 의 값"})`);
  for (const f of result.migration.findings) console.log(`    - ${f.kind} ${f.evidence}: ${f.statement}`);
  console.log(`  decision : ${summary.decision} (종료 코드 ${result.exitCode})`);
  console.log(`  targets  : ${summary.targets.length ? summary.targets.join(", ") : "(none)"}`);
  console.log(`  failover : ${summary.failover_allowed}`);
  for (const r of summary.requires) console.log(`  requires : ${r.id} (${r.rule_id}, in [${r.allowed_targets.join(", ")}])${r.hint ? ` — ${r.hint}` : ""}`);
  for (const r of plan.rules) {
    if (r.result === "matched") console.log(`  [${r.id}] ${r.reason}`);
    else if (r.result === "matched_after_block") console.log(`  [${r.id}] (차단 후) ${r.reason}`);
  }
  console.log(`  plan_hash: ${plan.plan_hash}`);
  console.log(`  -> ${summary.plan_path}`);
  for (const path of Object.values(result.explainPaths)) console.log(`  -> ${path}`);
  return result.exitCode;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    if (e instanceof StageError) {
      console.error(`오류 [단계: ${e.stage}] ${e.message}`);
      process.exitCode = EXIT_ERROR;
    } else if (e instanceof CliError) {
      console.error(`오류: ${e.message}`);
      process.exitCode = EXIT_ERROR;
    } else {
      throw e;
    }
  });
