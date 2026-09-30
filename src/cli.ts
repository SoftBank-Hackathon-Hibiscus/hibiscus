/**
 * CLI: 파일 읽기 -> 스키마 검증 -> decide -> plan.json 쓰기 -> decisions.jsonl 에 한 줄 추가
 *
 *   npx tsx src/cli.ts --test test_result.json --pii pii.json --policy policy.yaml --out plan.json
 *   옵션: --log decisions.jsonl (기본값: ./decisions.jsonl)
 */
import { decide, matchedRuleIds } from "./engine.js";
import { appendDecisionLog, loadJson, loadPolicy, parseArgs, requireArgs, runCli, validate, writeJson } from "./io.js";
import { PiiReportSchema, TestResultSchema } from "./schema.js";

const USAGE = `사용법:
  npx tsx src/cli.ts --test <test_result.json> --pii <pii.json> --policy <policy.yaml> --out <plan.json> [--log <decisions.jsonl>]

옵션:
  --test    테스트 판정 결과 (필수)
  --pii     개인정보 후보 (필수)
  --policy  정책 파일 YAML (필수)
  --out     출력할 배포 계획 경로 (필수)
  --log     결정 기록 파일. 한 줄씩 추가만 한다 (기본: ./decisions.jsonl)
  --help    이 도움말`;

runCli(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["test", "pii", "policy", "out"], USAGE);
  const testPath = args.test!;
  const piiPath = args.pii!;
  const policyPath = args.policy!;
  const outPath = args.out!;
  const logPath = args.log ?? "decisions.jsonl";

  const test = validate(TestResultSchema, loadJson(testPath, "test_result"), "test_result", testPath);
  const pii = validate(PiiReportSchema, loadJson(piiPath, "pii"), "pii", piiPath);
  const policy = loadPolicy(policyPath);

  const plan = decide(test, pii, policy);
  writeJson(outPath, plan);
  // 시간 값은 엔진 밖(기록)에서만 붙는다. 기록은 append 만 하고 기존 줄은 건드리지 않는다.
  appendDecisionLog(logPath, {
    kind: "deploy",
    run_id: plan.run_id,
    digest: plan.digest,
    decision: plan.decision,
    targets: plan.targets,
    rule_ids: matchedRuleIds(plan.rules),
    plan_hash: plan.plan_hash,
  });

  console.log(`[policy-engine] run_id=${plan.run_id} digest=${plan.digest}`);
  console.log(`  decision : ${plan.decision}`);
  console.log(`  targets  : ${plan.targets.length ? plan.targets.join(", ") : "(none)"}`);
  console.log(`  failover : ${plan.failover_allowed}`);
  for (const r of plan.requires ?? []) console.log(`  requires : ${r.id} (${r.rule_id}, in [${r.allowed_targets.join(", ")}])${r.hint ? ` — ${r.hint}` : ""}`);
  for (const r of plan.rules) {
    if (r.result === "matched") console.log(`  [${r.id}] ${r.reason}`);
    else if (r.result === "matched_after_block") console.log(`  [${r.id}] (차단 후) ${r.reason}`);
  }
  console.log(`  plan_hash: ${plan.plan_hash}`);
  console.log(`  -> ${outPath} (기록: ${logPath})`);
  return 0;
});
