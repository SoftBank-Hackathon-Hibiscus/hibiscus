import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { SignLogSchema, type SignLog } from "./schema.js";

/** CLI 에서 종료 코드 2 로 끝나는 오류 */
export class SignerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 키 정렬 JSON (policy 와 같은 방식) */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SignerError("READ_FAILED", `${label} 파일을 읽지 못함: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SignerError("JSON_INVALID", `${label} 파일이 JSON 이 아님: ${path}`);
  }
}

export function parseWith<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "(최상위)";
    throw new SignerError(`${label.toUpperCase()}_INVALID`, `${label} 형식 오류 ${where}: ${first?.message ?? "알 수 없음"}`);
  }
  return parsed.data;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** decisions.jsonl 의 kind: sign 한 줄. 감사 로그에도 같은 내용을 씀 */
export function signLogLine(entry: Omit<SignLog, "time" | "kind">, now: Date): SignLog {
  return SignLogSchema.parse({ kind: "sign", time: now.toISOString(), ...entry });
}

/** decisions.jsonl 에 한 줄 추가 */
export function appendSignLog(path: string, line: SignLog): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}
