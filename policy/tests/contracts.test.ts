import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { CONTRACTS, type JsonSchema, findContract, renderReadme, schemaFileName, toJsonSchema } from "../src/contracts.js";
import { decide } from "../src/engine.js";
import { decideRollback } from "../src/rollback/engine.js";
import { PiiReportSchema, PolicySchema, RollbackRequestSchema, TestResultSchema } from "../src/schema.js";

const ROOT = join(import.meta.dirname, "..");
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const policy = PolicySchema.parse(parseYaml(readFileSync(join(ROOT, "policy.yaml"), "utf8")));

const DEPLOY_FIXTURES = readdirSync(join(ROOT, "fixtures")).filter((d) => d !== "rollback");
const ROLLBACK_FIXTURES = readdirSync(join(ROOT, "fixtures", "rollback")).map((f) => f.replace(/\.json$/, ""));

const jsonSchemas = new Map(CONTRACTS.map((c) => [c.name, toJsonSchema(c)] as const));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map(CONTRACTS.map((c) => [c.name, ajv.compile(jsonSchemas.get(c.name)!)] as const));

function expectValid(name: string, data: unknown, label: string) {
  const validate = validators.get(name)!;
  const ok = validate(data);
  expect(ok, `${label} 이(가) ${name} JSON Schema 에 맞지 않음: ${JSON.stringify(validate.errors)}`).toBe(true);
  // zod 도 같은 판정을 내려야 한다
  expect(findContract(CONTRACTS.find((c) => c.name === name)!.typeKey)!.schema.safeParse(data).success, `${label} zod`).toBe(true);
}

/** fixture 를 그대로 (zod parse 로 default 를 채우지 않고) 읽는다 */
const rawDeploy = (fixture: string, file: string) => readJson(`fixtures/${fixture}/${file}`);
const planOf = (fixture: string) =>
  decide(TestResultSchema.parse(rawDeploy(fixture, "test_result.json")), PiiReportSchema.parse(rawDeploy(fixture, "pii.json")), policy);

describe("JSON Schema 로 fixtures 검증", () => {
  it("test_result.json fixtures 4개", () => {
    for (const f of DEPLOY_FIXTURES) expectValid("TestResult", rawDeploy(f, "test_result.json"), `fixtures/${f}/test_result.json`);
  });

  it("pii.json fixtures 4개", () => {
    for (const f of DEPLOY_FIXTURES) expectValid("PiiReport", rawDeploy(f, "pii.json"), `fixtures/${f}/pii.json`);
  });

  it("fixtures 로 만든 plan.json 4개", () => {
    for (const f of DEPLOY_FIXTURES) expectValid("Plan", planOf(f), `plan(${f})`);
  });

  it("rollback_request.json fixtures 6개", () => {
    for (const f of ROLLBACK_FIXTURES) expectValid("RollbackRequest", readJson(`fixtures/rollback/${f}.json`), `fixtures/rollback/${f}.json`);
  });

  it("fixtures 로 만든 rollback_plan.json 6개", () => {
    for (const f of ROLLBACK_FIXTURES) {
      const plan = decideRollback(RollbackRequestSchema.parse(readJson(`fixtures/rollback/${f}.json`)), policy);
      expectValid("RollbackPlan", plan, `rollback_plan(${f})`);
    }
  });

  it("결정 기록 줄 (deploy / rollback)", () => {
    const plan = planOf("04-pii-unconfident");
    expectValid(
      "DecisionLog",
      { kind: "deploy", time: "2026-09-30T00:00:00.000Z", run_id: plan.run_id, digest: plan.digest, decision: plan.decision, targets: plan.targets, rule_ids: ["R3", "R4"], plan_hash: plan.plan_hash },
      "deploy log",
    );
    const rb = decideRollback(RollbackRequestSchema.parse(readJson("fixtures/rollback/03-pii-onprem.json")), policy);
    expectValid(
      "DecisionLog",
      { kind: "rollback", time: "2026-09-30T00:00:00.000Z", run_id: rb.run_id, digest: `sha256:${"3".repeat(64)}`, serve_digest: rb.serve_digest, decision: rb.decision, targets: rb.targets, failover_allowed: rb.failover_allowed, rule_ids: ["RB3", "default"], plan_hash: rb.plan_hash },
      "rollback log",
    );
  });

  it("각 계약의 예시도 통과한다", () => {
    for (const c of CONTRACTS) expectValid(c.name, c.example(), `${c.name} example`);
  });
});

describe("JSON Schema 의 선택/필수 표시", () => {
  const required = (name: string) => new Set((jsonSchemas.get(name)!.required as string[]) ?? []);

  it("입력 파일: default 가 있는 필드는 선택, 나머지는 필수", () => {
    const tr = required("TestResult");
    expect(tr.has("run_id") && tr.has("digest") && tr.has("passed") && tr.has("match")).toBe(true);
    expect(tr.has("failures") || tr.has("facts")).toBe(false);
    expect(required("PiiReport").has("pii")).toBe(false);
    const piiItem = ((jsonSchemas.get("PiiReport")!.properties as Record<string, JsonSchema>).pii!.items as JsonSchema).required as string[];
    expect(piiItem).not.toContain("source");
    expect(piiItem).toEqual(expect.arrayContaining(["table", "column", "kind", "evidence", "confident"]));
  });

  it("출력 파일: requires 와 reason 은 선택, 나머지는 필수, 추가 필드 금지", () => {
    const plan = jsonSchemas.get("Plan")!;
    expect(required("Plan").has("requires")).toBe(false);
    expect(required("Plan").has("failover_allowed")).toBe(true);
    expect(plan.additionalProperties).toBe(false);
    const rule = (((plan.properties as Record<string, JsonSchema>).rules as JsonSchema).items as JsonSchema).required as string[];
    expect(rule).not.toContain("reason");
    expect(required("RollbackPlan").has("serve_digest")).toBe(true);
  });

  it("틀린 파일은 JSON Schema 와 zod 가 같이 거부한다", () => {
    const bad = { run_id: "r", app: "todo", digest: "abc", passed: "yes", match: { total: 1 } };
    expect(validators.get("TestResult")!(bad)).toBe(false);
    expect(TestResultSchema.safeParse(bad).success).toBe(false);
    const badLog = { kind: "deploy", time: "t", run_id: "r", digest: "d", decision: "rollback", targets: [], rule_ids: [], plan_hash: "h" };
    expect(validators.get("DecisionLog")!(badLog)).toBe(false);
  });

  it("설명이 필드에 붙어 있다", () => {
    const props = jsonSchemas.get("Plan")!.properties as Record<string, JsonSchema>;
    expect(props.requires!.description).toContain("해결 조건");
    expect(props.plan_hash!.description).toContain("sha256");
  });
});

describe("contracts/ 폴더가 최신인지", () => {
  /** 줄바꿈만 다른 것은 같은 내용으로 본다 (core.autocrlf=true 체크아웃이나 git archive 에서 CRLF 로 바뀔 수 있다) */
  const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

  it("npm run contracts 결과와 저장된 파일이 같다 (줄바꿈은 정규화해 비교)", () => {
    for (const c of CONTRACTS) {
      const file = join(ROOT, "contracts", schemaFileName(c));
      expect(existsSync(file), `${file} 없음. npm run contracts 를 실행하세요`).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")), `${schemaFileName(c)} 가 오래됨. npm run contracts 를 실행하세요`).toEqual(jsonSchemas.get(c.name));
    }
    const readme = join(ROOT, "contracts", "README.md");
    expect(existsSync(readme), "contracts/README.md 없음. npm run contracts 를 실행하세요").toBe(true);
    expect(normalizeEol(readFileSync(readme, "utf8")), "contracts/README.md 가 오래됨. npm run contracts 를 실행하세요").toBe(normalizeEol(renderReadme(CONTRACTS, jsonSchemas)));
  });

  it("저장된 README 가 CRLF 여도 내용이 같으면 통과한다", () => {
    const rendered = renderReadme(CONTRACTS, jsonSchemas);
    const crlf = rendered.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(rendered);
    expect(normalizeEol(crlf)).toBe(normalizeEol(rendered));
  });

  it("README 에 계약마다 필드 표와 예시가 있다", () => {
    const readme = renderReadme(CONTRACTS, jsonSchemas);
    for (const c of CONTRACTS) {
      expect(readme).toContain(`## ${c.fileName} — ${c.name}`);
      expect(readme).toContain(`--type ${c.typeKey}`);
    }
    expect(readme).toContain("| `state.pii_written_onprem` | boolean | 필수 |");
    expect(readme).toContain("| `requires` | object[] | 선택 |");
    expect(readme).toContain("| `requires[].hint` | string | 선택 |");
    expect(readme).toContain("| `requires[].rule_id` | string | 필수 |");
    expect(readme).toContain("| `requires[].allowed_targets` | string[] | 필수 |");
    expect(readme).toContain("`allowed_targets` 는 이 해결 조건과 연결된 정책 위반이 해소됐다고 가정했을 때, 나머지 정책 제약상 가능한 배포 위치다");
    expect(readme).toContain("추가 필드가 있으면 zod 와 JSON Schema 모두 거부한다");
    expect(readme).toContain("**kind = \"rollback\"**");
    expect(readme).toContain("팀과 합의가 필요한 점");
    expect(readme).toContain("```mermaid");
    // 정책이 읽는 필드 표
    expect(readme).toContain("## 정책이 읽는 필드");
    expect(readme).toContain("| `test.facts.db` | R5 | 조건, reason |");
    expect(readme).toContain("| `pii.pii[].confident` | R3 | 조건 |");
    expect(readme).toContain("| `request.state.db_migration_backward_compatible` | RB2 | 조건 |");
    // facts 의 정의된 키와 자유 키
    expect(readme).toContain('| `facts.db` | "sqlite" \\| "postgres" \\| "mysql" \\| "none" | 선택 |');
    expect(readme).toContain("| `facts.*` | any | 선택 |");
  });
});
