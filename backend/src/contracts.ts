/**
 * 루트 contracts/ 의 JSON Schema 로 단계 산출물의 형식을 검사한다.
 * 백엔드는 판단을 새로 하지 않는다. "다른 파트가 공개한 계약과 맞는 파일인가" 만 본다.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

const cache = new Map<string, ValidateFunction>();

/** 계약 위반 이유. 맞으면 undefined. 스키마 파일을 못 읽어도 위반으로 본다 (fail-closed) */
export function contractViolation(schemaPath: string, data: unknown, label: string): string | undefined {
  let validate = cache.get(schemaPath);
  if (!validate) {
    try {
      const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
      validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    } catch (e) {
      return `${label} 의 계약 스키마를 읽지 못함: ${schemaPath} (${e instanceof Error ? e.message : String(e)})`;
    }
    cache.set(schemaPath, validate);
  }
  if (!validate(data)) {
    const first = validate.errors?.[0];
    const where = first?.instancePath || "(최상위)";
    return `${label} 이 계약 ${basename(schemaPath)} 과 맞지 않음 ${where}: ${first?.message ?? "알 수 없음"}`;
  }
  return undefined;
}
