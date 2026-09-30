/**
 * 다른 파트가 자기 파일을 검증하는 CLI
 *
 *   npx tsx src/validate.ts --type test_result --file some.json
 *
 * --type: test_result | pii | plan | rollback_request | rollback_plan | decision_log (jsonl) | policy (yaml)
 * 통과하면 OK 와 종료 코드 0, 틀리면 어느 필드가 왜 틀렸는지 출력하고 종료 코드 1.
 */
import type { z } from "zod";
import { CONTRACTS, findContract } from "./contracts.js";
import { CliError, loadJson, loadYaml, parseArgs, readText, requireArgs, runCli } from "./io.js";
import { lintPolicy } from "./policy-refs.js";
import { PolicySchema } from "./schema.js";

const TYPES = [...CONTRACTS.map((c) => c.typeKey), "policy"];
const USAGE = `사용법:
  npx tsx src/validate.ts --type <형식> --file <파일>

형식:
${CONTRACTS.map((c) => `  ${c.typeKey.padEnd(17)} ${c.fileName} (${c.name})`).join("\n")}
  policy            policy.yaml`;

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join(".") : "(root)";
    return `  - ${where}: ${issue.message}`;
  });
}

function check(schema: z.ZodType, data: unknown): string[] {
  const result = schema.safeParse(data);
  return result.success ? [] : formatIssues(result.error);
}

runCli(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireArgs(args, ["type", "file"], USAGE);
  const type = args.type!;
  const file = args.file!;
  if (!TYPES.includes(type)) throw new CliError(`알 수 없는 형식: ${type}\n\n${USAGE}`);

  let problems: string[] = [];

  if (type === "policy") {
    const parsed = PolicySchema.safeParse(loadYaml(file, "policy"));
    if (parsed.success) {
      for (const w of lintPolicy(parsed.data)) console.error(`경고: ${w}`);
    } else {
      problems = formatIssues(parsed.error);
    }
  } else if (type === "decision_log") {
    const contract = findContract(type)!;
    const lines = readText(file, contract.fileName).split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        problems.push(`  - ${i + 1}번째 줄: JSON 이 아닙니다 (${(e as Error).message})`);
        return;
      }
      problems.push(...check(contract.schema, parsed).map((p) => `  - ${i + 1}번째 줄:${p.slice(3)}`));
    });
  } else {
    const contract = findContract(type)!;
    problems = check(contract.schema, loadJson(file, contract.fileName));
  }

  if (problems.length === 0) {
    console.log(`OK: ${file} 은(는) ${type} 형식에 맞습니다`);
    return 0;
  }
  console.error(`실패: ${file} 은(는) ${type} 형식에 맞지 않습니다 (${problems.length}건)`);
  for (const p of problems) console.error(p);
  return 1;
});
