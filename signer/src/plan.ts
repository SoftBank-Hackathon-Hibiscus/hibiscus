// Plan.schema.json 으로 검사. 스키마를 못 읽으면 서명 안 함
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalize, parseWith, readJson, sha256Hex, SignerError } from "./io.js";
import { PlanSchema, type Plan } from "./schema.js";

// 파트 사이 공개 계약(루트 contracts/)의 Plan 스키마. 정책 폴더 원본과 같은지는 policy 테스트가 확인
export const DEFAULT_PLAN_SCHEMA = fileURLToPath(new URL("../../contracts/Plan.schema.json", import.meta.url));

export interface LoadedPlan {
  plan: Plan;
  /** plan.json 전체 해시. 승인 뒤 내용이 바뀌었는지 볼 때 씀 */
  planSha256: string;
}

export function loadPlan(path: string, schemaPath: string = DEFAULT_PLAN_SCHEMA): LoadedPlan {
  let validate;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  } catch {
    throw new SignerError("SCHEMA_UNAVAILABLE", `plan 스키마를 불러오지 못해 서명하지 않음: ${schemaPath}`);
  }
  const data = readJson(path, "plan");
  if (!validate(data)) {
    const first = validate.errors?.[0];
    const where = first?.instancePath || "(최상위)";
    throw new SignerError("PLAN_INVALID", `plan 이 Plan 스키마와 맞지 않음 ${where}: ${first?.message ?? "알 수 없음"}`);
  }
  const plan = parseWith(PlanSchema, data, "plan");
  return { plan, planSha256: sha256Hex(canonicalize(data)) };
}
