/**
 * CLI: parity 인계 묶음 → test_result.json
 *
 *   npx tsx src/adapters/cli.ts --handoff <handoff.json> [--diagnostics <result.diagnostics.json>] --out <test_result.json>
 *
 * 종료 코드: 0 변환 성공 (경고는 stderr), 1 형식 오류·변환 거부 (재생 중단, 진단 미완료, digest 불일치 등)
 */
import { parseArgs, requireArgs, runCli, writeJson } from "../io.js";
import { loadParityHandoff } from "./load.js";
import { summarizeConditions } from "./parity.js";

const USAGE = `사용법:
  npx tsx src/adapters/cli.ts --handoff <handoff.json> [--diagnostics <result.diagnostics.json>] --out <test_result.json>

옵션:
  --handoff      python -m parity.handoff 가 만든 인계 묶음 (parity-handoff-v1-proposal) (필수)
  --diagnostics  parity test 가 함께 쓴 실행 진단 (result.diagnostics.json). 있으면 status 와 digest 를 대조한다
  --out          출력할 test_result.json (필수)
  --help         이 도움말

변환기는 관찰된 사실만 옮긴다 (passed 원본 유지, match 는 none 조건, facts.conditions / facts.storage 추가).
판단은 policy.yaml 의 규칙이 한다. 재생이 중단됐거나 진단이 completed 가 아니면 종료 코드 1 로 멈춘다.`;

runCli(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["handoff", "out"], USAGE);

  const { test, warnings } = loadParityHandoff(args.handoff!, args.diagnostics);
  writeJson(args.out!, test);

  for (const w of warnings) console.error(`경고: ${w}`);
  console.log(`[parity-adapter] run_id=${test.run_id} app=${test.app} digest=${test.digest} source_revision=${test.source_revision ?? "(없음)"}`);
  console.log(`  passed    : ${test.passed} (parity 원본 종합값. 판단은 정책 규칙이 조건별 사실로 한다)`);
  console.log(`  match     : ${test.match.matched}/${test.match.total} (none 조건)`);
  console.log(`  conditions: ${summarizeConditions(test.facts.conditions ?? [])}`);
  console.log(`  facts.db  : ${test.facts.db ?? "(생략)"}`);
  console.log(`  writes    : ${test.facts.writes_local_file?.length ? test.facts.writes_local_file.join(", ") : "(없음)"}`);
  console.log(`  -> ${args.out}`);
  return 0;
});
