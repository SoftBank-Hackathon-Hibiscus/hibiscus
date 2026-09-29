/**
 * CLI: 앱 폴더 → 추출 → 판정 → pii.json (정책 엔진이 받는 형식)
 *
 *   npx tsx src/pii/cli.ts --src <앱 폴더> --run-id r-001 --out pii.json [--classifier heuristic|llm|replay]
 *   옵션:
 *     --recording <파일>   replay 용 녹화 파일 (기본: recordings/<run-id>.json)
 *     --record             llm 호출 결과를 recordings/<run-id>.json 에 저장
 */
import { CliError, parseArgs, requireArgs, runCli, writeJson } from "../io.js";
import { PiiReportSchema } from "../schema.js";
import { extract, loadSources } from "./extractor.js";
import { selectClassifier } from "./select.js";

const USAGE = `사용법:
  npx tsx src/pii/cli.ts --src <앱 폴더> --run-id <run_id> --out <pii.json> [--classifier heuristic|llm|replay] [--recording <파일>] [--record]

옵션:
  --src         분석할 앱 소스 폴더 (필수)
  --run-id      test_result.json 과 같은 run_id (필수)
  --out         출력할 pii.json 경로 (필수)
  --classifier  heuristic (기본) | llm (ANTHROPIC_API_KEY 필요, 없으면 heuristic) | replay (녹화 재생)
  --recording   replay 에 쓸 녹화 파일. 기본 recordings/<run_id>.json
  --record      llm 결과를 recordings/<run_id>.json 에 저장 (호출한 모델도 함께 기록)
  --help        이 도움말

환경변수:
  ANTHROPIC_API_KEY  llm 판정기에 필요
  PII_LLM_MODEL      llm 판정기가 쓸 모델 (기본: claude-haiku-4-5-20251001)`;

const FLAGS = new Set(["record"]);

runCli(async () => {
  const args = parseArgs(process.argv.slice(2), FLAGS);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["src", "run-id", "out"], USAGE);
  const src = args.src!;
  const runId = args["run-id"]!;
  const outPath = args.out!;

  let files;
  try {
    files = loadSources(src);
  } catch (e) {
    throw new CliError(`앱 폴더를 읽을 수 없습니다: ${src} (${(e as Error).message})`);
  }
  const candidates = extract(files);
  const { classifier, notes } = selectClassifier({ mode: args.classifier, runId, recording: args.recording, record: args.record === "true" });
  const results = await classifier.classify(candidates);

  const report = PiiReportSchema.parse({ run_id: runId, pii: results });
  writeJson(outPath, report);

  console.log(`[pii] run_id=${runId} src=${src} classifier=${classifier.name}`);
  for (const n of notes) console.log(`  ! ${n}`);
  console.log(`  files    : ${files.length}`);
  console.log(`  columns  : ${candidates.length}`);
  console.log(`  pii      : ${results.length}`);
  for (const r of results) {
    console.log(`  - ${r.table}.${r.column} ${r.kind} confident=${r.confident} [${r.source}] ${r.evidence}`);
  }
  console.log(`  -> ${outPath}`);
  return 0;
});
