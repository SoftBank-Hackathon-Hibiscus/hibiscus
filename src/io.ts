/**
 * CLI 들이 공유하는 입출력 도우미. 엔진(순수 함수)은 이 파일을 쓰지 않는다.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { type DecisionLog, DecisionLogSchema } from "./schema.js";

export class CliError extends Error {}

/**
 * `--key value` 형태를 객체로. flags 에 있는 키는 값 없이 `--key` 만으로 "true".
 * `--help` / `-h` 는 항상 flag.
 */
export function parseArgs(argv: string[], flags: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.help = "true";
      continue;
    }
    if (!arg.startsWith("--")) throw new CliError(`알 수 없는 인자: ${arg}`);
    const key = arg.slice(2);
    if (flags.has(key)) {
      out[key] = "true";
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`${arg} 뒤에 값이 필요합니다`);
    out[key] = value;
    i++;
  }
  return out;
}

export function requireArgs(args: Record<string, string>, keys: string[], usage: string): void {
  for (const key of keys) {
    if (!args[key]) throw new CliError(`--${key} 옵션이 필요합니다\n\n${usage}`);
  }
}

export function readText(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new CliError(`${label} 파일을 읽을 수 없습니다: ${path} (${(e as Error).message})`);
  }
}

export function loadJson(path: string, label: string): unknown {
  const text = readText(path, label);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${label} 파일이 올바른 JSON 이 아닙니다: ${path} (${(e as Error).message})`);
  }
}

export function loadYaml(path: string, label: string): unknown {
  const text = readText(path, label);
  try {
    return parseYaml(text);
  } catch (e) {
    throw new CliError(`${label} 파일이 올바른 YAML 이 아닙니다: ${path} (${(e as Error).message})`);
  }
}

export function validate<T>(schema: z.ZodType<T>, data: unknown, label: string, path: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join(".") : "(root)";
    return `  - ${where}: ${issue.message}`;
  });
  throw new CliError(`${label} 형식 오류: ${path}\n${lines.join("\n")}`);
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** 유니언의 각 멤버에서 키를 빼는 Omit (일반 Omit 은 discriminated union 을 뭉갠다) */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** decisions.jsonl 에 한 줄 추가. 기존 줄은 건드리지 않는다. 시간 값은 여기서만 붙는다 */
export function appendDecisionLog(path: string, entry: DistributiveOmit<DecisionLog, "time">): void {
  const withTime = DecisionLogSchema.parse({ ...entry, time: new Date().toISOString() });
  mkdirSync(dirname(resolve(path)), { recursive: true });
  appendFileSync(path, JSON.stringify(withTime) + "\n", "utf8");
}

/** main 을 감싸 CliError 만 깔끔히 출력하고 종료 코드 1 로 끝낸다 */
export function runCli(main: () => number | Promise<number>): void {
  Promise.resolve()
    .then(main)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      if (e instanceof CliError) {
        console.error(`오류: ${e.message}`);
        process.exitCode = 1;
      } else {
        throw e;
      }
    });
}
