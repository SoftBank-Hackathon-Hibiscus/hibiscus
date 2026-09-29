/**
 * CLI: rollback_request.json + policy.yaml -> rollback_plan.json, decisions.jsonl 에 kind=rollback 로 추가
 *
 *   npx tsx src/rollback/cli.ts --request rollback_request.json --policy policy.yaml --out rollback_plan.json [--log decisions.jsonl]
 */
import { CliError, appendDecisionLog, loadJson, loadPolicy, parseArgs, requireArgs, runCli, validate, writeJson } from "../io.js";
import { RollbackRequestSchema } from "../schema.js";
import { decideRollback } from "./engine.js";

const USAGE = `사용법:
  npx tsx src/rollback/cli.ts --request <rollback_request.json> --policy <policy.yaml> --out <rollback_plan.json> [--log <decisions.jsonl>]

옵션:
  --request  롤백 판단 요청 (필수)
  --policy   정책 파일 YAML. rollback 섹션이 있어야 한다 (필수)
  --out      출력할 rollback_plan.json 경로 (필수)
  --log      결정 기록 파일. 배포 결정과 같은 파일에 kind=rollback 으로 추가한다 (기본: ./decisions.jsonl)
  --help     이 도움말`;

runCli(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["request", "policy", "out"], USAGE);
  const requestPath = args.request!;
  const policyPath = args.policy!;
  const outPath = args.out!;
  const logPath = args.log ?? "decisions.jsonl";

  const request = validate(RollbackRequestSchema, loadJson(requestPath, "rollback_request"), "rollback_request", requestPath);
  const policy = loadPolicy(policyPath);
  if (!policy.rollback) throw new CliError(`policy 에 rollback 섹션이 없습니다: ${policyPath}`);

  const plan = decideRollback(request, policy);
  writeJson(outPath, plan);
  appendDecisionLog(logPath, {
    kind: "rollback",
    run_id: plan.run_id,
    digest: request.candidate.digest,
    serve_digest: plan.serve_digest,
    decision: plan.decision,
    targets: plan.targets,
    failover_allowed: plan.failover_allowed,
    rule_ids: plan.rules.filter((r) => r.result === "matched").map((r) => r.id),
    plan_hash: plan.plan_hash,
  });

  console.log(`[rollback] run_id=${plan.run_id} stage=${request.stage} candidate=${request.candidate.digest} stable=${request.stable.digest}`);
  console.log(`  decision : ${plan.decision}`);
  console.log(`  serve    : ${plan.serve_digest ?? "(none: manual recovery)"}`);
  console.log(`  targets  : ${plan.targets.length ? plan.targets.join(", ") : "(none)"}`);
  console.log(`  failover : ${plan.failover_allowed}`);
  for (const r of plan.rules) {
    if (r.result === "matched") console.log(`  [${r.id}] ${r.reason}`);
  }
  console.log(`  plan_hash: ${plan.plan_hash}`);
  console.log(`  -> ${outPath} (기록: ${logPath})`);
  return 0;
});
