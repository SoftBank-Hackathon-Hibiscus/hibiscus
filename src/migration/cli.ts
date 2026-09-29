/**
 * CLI: 앱 폴더의 마이그레이션 파일 → migration.json (test_result.facts.migration 형식)
 *
 *   npx tsx src/migration/cli.ts --src <앱 폴더> [--since <마이그레이션 이름>] --out migration.json
 */
import { CliError, parseArgs, requireArgs, runCli, writeJson } from "../io.js";
import { MigrationReportSchema } from "../schema.js";
import { analyzeMigrations } from "./analyzer.js";
import { filterSince, loadMigrationFiles } from "./loader.js";

const USAGE = `사용법:
  npx tsx src/migration/cli.ts --src <앱 폴더> [--since <마이그레이션 이름>] --out <migration.json>

옵션:
  --src    앱 소스 폴더 (필수). migrations/**/*.sql 과 prisma/migrations/*/migration.sql 을 본다
  --since  이 이름보다 뒤의 마이그레이션만 검사 (예: 0002_add_phone, 20240101000000_init). 없으면 전부
  --out    출력할 migration.json (필수)
  --help   이 도움말

출력은 test_result.json 의 facts.migration 형식과 같다:
  { destructive, backward_compatible, findings: [{ kind, statement, evidence }] }`;

runCli(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["src", "out"], USAGE);
  const src = args.src!;
  const outPath = args.out!;

  let all;
  try {
    all = loadMigrationFiles(src);
  } catch (e) {
    throw new CliError(`앱 폴더를 읽을 수 없습니다: ${src} (${(e as Error).message})`);
  }
  const { files, sinceFound } = filterSince(all, args.since);
  const report = MigrationReportSchema.parse(analyzeMigrations(files));
  writeJson(outPath, report);

  console.log(`[migration] src=${src}${args.since ? ` since=${args.since}` : ""}`);
  if (!sinceFound) console.log(`  ! --since 이름을 마이그레이션 목록에서 찾지 못했습니다: ${args.since} (이름보다 뒤인 파일만 검사함)`);
  console.log(`  files    : ${files.length}${all.length !== files.length ? ` (전체 ${all.length})` : ""}`);
  console.log(`  destructive: ${report.destructive}  backward_compatible: ${report.backward_compatible}`);
  for (const f of report.findings) console.log(`  - ${f.kind} ${f.evidence}: ${f.statement}`);
  console.log(`  -> ${outPath}`);
  return 0;
});
