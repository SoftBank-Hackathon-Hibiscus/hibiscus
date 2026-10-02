/**
 * 팀 계약 문서의 원천. zod 스키마 → JSON Schema + contracts/README.md.
 *
 * - CONTRACTS 는 다른 파트와 주고받는 파일 6개의 목록이다.
 * - toJsonSchema() 는 zod 4 의 z.toJSONSchema 를 쓴다. 입력 파일은 io:"input" (default 가 있는 필드는 선택),
 *   출력 파일은 io:"output" (우리가 항상 채우므로 필수, 추가 필드 없음).
 * - 예시는 fixtures 에서 가져오거나 fixtures 로 엔진을 돌려 만든다. 시간 값만 고정 문자열이다.
 *
 * 생성은 scripts/contracts.ts 가 한다 (npm run contracts). 이 파일은 파일을 쓰지 않는다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { decide, matchedRuleIds } from "./engine.js";
import { type PathRef, collectPolicyPaths } from "./policy-refs.js";
import { decideRollback } from "./rollback/engine.js";
import {
  DecisionLogSchema,
  PiiReportSchema,
  PlanSchema,
  PolicySchema,
  RollbackPlanSchema,
  RollbackRequestSchema,
  TestResultSchema,
} from "./schema.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Contract {
  /** JSON Schema 의 title, 파일 이름의 앞부분 */
  name: string;
  /** validate CLI 의 --type 값 */
  typeKey: string;
  /** 파이프라인에서 쓰는 파일 이름 */
  fileName: string;
  schema: z.ZodType;
  io: "input" | "output";
  producer: string;
  consumer: string;
  purpose: string;
  /** 예시를 어디서 가져왔는지 (README 에 적는다) */
  exampleSource: string;
  example: () => unknown;
}

const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const policy = () => PolicySchema.parse(parseYaml(readFileSync(join(ROOT, "policy.yaml"), "utf8")));
const EXAMPLE_TIME = "2026-09-30T00:00:00.000Z";

const planOf = (fixture: string) =>
  decide(
    TestResultSchema.parse(readJson(`fixtures/${fixture}/test_result.json`)),
    PiiReportSchema.parse(readJson(`fixtures/${fixture}/pii.json`)),
    policy(),
  );
const rollbackPlanOf = (fixture: string) => decideRollback(RollbackRequestSchema.parse(readJson(`fixtures/rollback/${fixture}.json`)), policy());

export const CONTRACTS: Contract[] = [
  {
    name: "TestResult",
    typeKey: "test_result",
    fileName: "test_result.json",
    schema: TestResultSchema,
    io: "input",
    producer: "테스트 파트",
    consumer: "정책 엔진 (`src/cli.ts`)",
    purpose: "로컬에서 기록한 요청/응답을 클라우드 조건에서 재생한 판정 결과와, 테스트 중 관찰한 사실(facts)",
    exampleSource: "fixtures/03-pii-confident/test_result.json",
    example: () => readJson("fixtures/03-pii-confident/test_result.json"),
  },
  {
    name: "PiiReport",
    typeKey: "pii",
    fileName: "pii.json",
    schema: PiiReportSchema,
    io: "input",
    producer: "개인정보 판정 모듈 (`src/pii/cli.ts`, 이 저장소)",
    consumer: "정책 엔진 (`src/cli.ts`)",
    purpose: "앱 소스에서 찾은 개인정보 후보 칼럼과 확신 여부",
    exampleSource: "fixtures/03-pii-confident/pii.json",
    example: () => readJson("fixtures/03-pii-confident/pii.json"),
  },
  {
    name: "Plan",
    typeKey: "plan",
    fileName: "plan.json",
    schema: PlanSchema,
    io: "output",
    producer: "정책 엔진 (`src/cli.ts`, 이 저장소)",
    consumer: "서명 파트 (승인·서명), 배포 파트 (targets, failover_allowed), AI 수정 파트 (requires)",
    purpose: "배포 허용/차단/승인 필요 결정과 배포 위치, 그리고 그 근거",
    exampleSource: "fixtures/03-pii-confident 를 정책 엔진에 넣은 결과",
    example: () => planOf("03-pii-confident"),
  },
  {
    name: "RollbackRequest",
    typeKey: "rollback_request",
    fileName: "rollback_request.json",
    schema: RollbackRequestSchema,
    io: "input",
    producer: "배포 파트",
    consumer: "롤백 판단 모듈 (`src/rollback/cli.ts`)",
    purpose: "배포 후 문제가 생겼을 때, 후보/정상 버전과 배포 파트가 관찰한 상태",
    exampleSource: "fixtures/rollback/03-pii-onprem.json",
    example: () => readJson("fixtures/rollback/03-pii-onprem.json"),
  },
  {
    name: "RollbackPlan",
    typeKey: "rollback_plan",
    fileName: "rollback_plan.json",
    schema: RollbackPlanSchema,
    io: "output",
    producer: "롤백 판단 모듈 (`src/rollback/cli.ts`, 이 저장소)",
    consumer: "배포 파트 (실제 롤백 실행)",
    purpose: "되돌릴지, 어느 버전이 트래픽을 받을지, 어느 대상에서",
    exampleSource: "fixtures/rollback/03-pii-onprem.json 을 롤백 판단에 넣은 결과",
    example: () => rollbackPlanOf("03-pii-onprem"),
  },
  {
    name: "DecisionLog",
    typeKey: "decision_log",
    fileName: "decisions.jsonl",
    schema: DecisionLogSchema,
    io: "output",
    producer: "정책 엔진과 롤백 판단 모듈 (이 저장소)",
    consumer: "발표·감사·디버깅 (사람), 필요하면 대시보드",
    purpose: "모든 결정을 한 줄씩 추가만 하는 기록. kind 로 배포/롤백 구분",
    exampleSource: "Plan 예시로 만든 배포 결정 한 줄 (시간은 고정값)",
    example: () => {
      const plan = planOf("03-pii-confident");
      return {
        kind: "deploy",
        time: EXAMPLE_TIME,
        run_id: plan.run_id,
        digest: plan.digest,
        ...(plan.source_revision !== undefined ? { source_revision: plan.source_revision } : {}),
        decision: plan.decision,
        targets: plan.targets,
        rule_ids: matchedRuleIds(plan.rules),
        plan_hash: plan.plan_hash,
      };
    },
  },
];

export function findContract(typeKey: string): Contract | undefined {
  return CONTRACTS.find((c) => c.typeKey === typeKey);
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(contract: Contract): JsonSchema {
  const schema = z.toJSONSchema(contract.schema, { target: "draft-2020-12", io: contract.io, unrepresentable: "any" }) as JsonSchema;
  return { $id: `${contract.name}.schema.json`, title: contract.name, ...schema };
}

export function schemaFileName(contract: Contract): string {
  return `${contract.name}.schema.json`;
}

// ---------------------------------------------------------------------------
// contracts/README.md
// ---------------------------------------------------------------------------

interface FieldRow {
  path: string;
  type: string;
  required: string;
  description: string;
}

function typeOf(prop: JsonSchema): string {
  if (Array.isArray(prop.enum)) return (prop.enum as unknown[]).map((v) => JSON.stringify(v)).join(" \\| ");
  if (prop.const !== undefined) return JSON.stringify(prop.const);
  const t = prop.type;
  if (Array.isArray(t)) return t.join(" \\| ");
  if (t === "array") {
    const items = (prop.items ?? {}) as JsonSchema;
    const inner = items.type === "object" ? "object" : typeOf(items);
    return `${inner}[]`;
  }
  if (t === "object") return "object";
  if (typeof t === "string") return t;
  if (Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf)) return "union";
  return "any";
}

function fieldRows(schema: JsonSchema, prefix = ""): FieldRow[] {
  const rows: FieldRow[] = [];
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  for (const [key, prop] of Object.entries(props)) {
    const path = prefix + key;
    let req = required.has(key) ? "필수" : "선택";
    if (prop.default !== undefined) req += ` (기본값 \`${JSON.stringify(prop.default)}\`)`;
    rows.push({ path, type: typeOf(prop), required: req, description: String(prop.description ?? "") });
    if (prop.type === "object" && prop.properties) {
      rows.push(...fieldRows(prop, `${path}.`));
      // looseObject: 정의된 키 외의 키도 허용
      const extra = prop.additionalProperties;
      if (extra === true || (typeof extra === "object" && extra !== null && Object.keys(extra).length === 0)) {
        rows.push({ path: `${path}.*`, type: "any", required: "선택", description: "그 밖의 키는 자유. 그대로 보존되지만 정책은 읽지 않는다" });
      }
    }
    const items = prop.items as JsonSchema | undefined;
    if (prop.type === "array" && items?.type === "object" && items.properties) rows.push(...fieldRows(items, `${path}[].`));
  }
  return rows;
}

function policyPathsSection(): string {
  const refs = collectPolicyPaths(policy());
  const render = (rows: PathRef[]) =>
    [
      "| 경로 | 읽는 규칙 | 용도 |",
      "|---|---|---|",
      ...rows.map((r) => `| \`${r.path}\` | ${r.rules.join(", ")} | ${r.uses.map((u) => (u === "condition" ? "조건" : "reason")).join(", ")} |`),
    ].join("\n");
  return [
    "## 정책이 읽는 필드",
    "",
    "`policy.yaml` 의 규칙이 실제로 참조하는 경로. 여기 나온 필드를 바꾸면 정책도 같이 봐야 한다. `npm run contracts` 가 규칙에서 자동으로 모은다.",
    "",
    "`some` 조건 안의 경로는 `배열[].필드` 로 적었다. 조건에서 읽는 필드는 값의 형식이 정확해야 하고(예: `test.facts.db` 는 소문자 enum), reason 에서만 읽는 필드는 표시용이다.",
    "",
    "**배포 규칙** (루트 `{ test: test_result.json, pii: pii.json }`)",
    "",
    render(refs.deploy),
    "",
    "**롤백 규칙** (루트 `{ request: rollback_request.json }`)",
    "",
    render(refs.rollback),
    "",
    "규칙이 `test.facts` 의 정의되지 않은 키를 읽으면 정책을 불러올 때 경고가 난다. 새 키가 필요하면 `src/schema.ts` 의 `FactsSchema` 에 먼저 추가한다.",
  ].join("\n");
}

function table(rows: FieldRow[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  return ["| 필드 | 타입 | 필수 | 설명 |", "|---|---|---|---|", ...rows.map((r) => `| \`${r.path}\` | ${r.type} | ${r.required} | ${esc(r.description)} |`)].join("\n");
}

function fieldSection(schema: JsonSchema): string {
  const variants = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (!variants) return table(fieldRows(schema));
  return variants
    .map((v) => {
      const props = (v.properties ?? {}) as Record<string, JsonSchema>;
      const disc = Object.entries(props).find(([, p]) => p.const !== undefined);
      const title = disc ? `${disc[0]} = ${JSON.stringify(disc[1]!.const)}` : "variant";
      return `**${title}**${v.description ? ` — ${v.description}` : ""}\n\n${table(fieldRows(v))}`;
    })
    .join("\n\n");
}

const FLOW = `\`\`\`mermaid
flowchart LR
  T[테스트 파트] -->|test_result.json| PE[정책 엔진<br/>src/cli.ts]
  P[개인정보 판정<br/>src/pii/cli.ts] -->|pii.json| PE
  PE -->|plan.json| S[서명 파트<br/>사람 승인 + 이미지 서명]
  S -->|서명된 이미지 + plan.json| D[배포 파트<br/>Cloud Run / 온프레]
  PE -->|plan.requires| F[AI 수정 파트]
  D -->|rollback_request.json| RB[롤백 판단<br/>src/rollback/cli.ts]
  RB -->|rollback_plan.json| D
  PE -.->|decisions.jsonl kind=deploy| L[(결정 기록)]
  RB -.->|decisions.jsonl kind=rollback| L
  ST[보안 단계 실행기<br/>src/stage.ts] -.->|개인정보 판정 + 정책 결정을 한 명령으로| PE
\`\`\`

보안 단계 실행기(\`npx tsx src/stage.ts --src <앱> --test test_result.json --policy policy.yaml --out-dir <폴더>\`)는 개인정보 판정과 정책 결정을 한 번에 돌려 \`pii.json\` 과 \`plan.json\` 을 만들고, 결정을 종료 코드로 알린다 (allow 0, needs_approval 2, block 3, 실행 오류 1). 파일 형식은 위와 같다.`;

const AGREEMENTS = `## 팀과 합의가 필요한 점

1. **run_id 와 digest 는 끝까지 그대로 전달한다.** \`source_revision\`(커밋 SHA, 선택)도 있으면 그대로 전달한다 (아래 "최근 추가된 필드" 참고). 테스트 파트가 정한 \`run_id\` 와 이미지 \`digest\` 가 test_result → pii → plan → 서명 → 배포 → rollback_request 까지 바뀌지 않아야 한다. 정책 엔진은 test_result 와 pii 의 \`run_id\` 가 다르면 차단한다(R2). \`digest\` 는 \`sha256:\` + 소문자 hex 64자만 받고(결정 기록의 digest 와 plan_hash 도 같은 형식), \`run_id\` 는 영문·숫자·\`._-\` 만 1~64자다. rollback_request 의 \`candidate.targets\` 와 \`stable.targets\` 는 \`known_targets\` 안에 있어야 한다.
2. **비밀값은 어떤 파일에도 넣지 않는다.** API 키, 토큰, 접속 문자열을 \`facts\`, \`failures\`, \`evidence\` 등에 넣지 말 것. 개인정보 판정 모듈은 근거 조각의 비밀처럼 보이는 값을 \`[REDACTED]\` 로 가리지만, 다른 파트의 파일은 각자 책임진다.
3. **선택 필드는 "없을 수 있다" 는 뜻이지 "null 을 넣어도 된다" 는 뜻이 아니다.** 예: \`plan.requires\` 는 없거나 객체 배열이다. \`pii[].source\` 도 마찬가지.
4. **최근 추가된 필드**
   - \`test_result.source_revision\` / \`rollback_request.source_revision\` (선택, 소문자 hex 7~40자): 테스트한 소스의 **커밋 SHA**. 백엔드가 webhook 의 커밋 SHA 를 고정해서 넘긴다. 아직 선택이며 \`"unknown"\` 은 없는 것으로 취급한다. 값이 있으면 \`plan.source_revision\` / \`rollback_plan.source_revision\` 과 결정 기록(\`decisions.jsonl\`)에 그대로 실리고 \`plan_hash\` 에도 반영된다. 없으면 출력에 필드 자체가 없고 기존 \`plan_hash\` 는 바뀌지 않는다. 보안 단계 실행기의 \`--source-revision\` 옵션이 test_result 의 값보다 우선하며, 둘 다 있는데 다르면 실행 오류(종료 코드 1)다. 결정 설명의 맨 아래 줄에 커밋 앞 7자리가 표시된다.
   - \`plan.requires\` / \`rollback_plan.requires\` (선택, \`[{ id, hint?, rule_id, allowed_targets }]\`): 해결 조건. 걸린 규칙들이 "이 규칙을 피하려면 무엇이 필요한가" 를 적은 것을 id 로 합치고 id 순으로 정렬한 것 (예: \`[{ "id": "managed_db", "hint": "SQLite를 PostgreSQL로 전환", "rule_id": "R5", "allowed_targets": ["onprem", "cloud_run"] }]\`). AI 수정 파트가 \`id\` 로 분기하고 \`hint\` 를 사람에게 보여준다. \`decision\` 이 \`block\` / \`needs_approval\` / \`manual_recovery\` 면 항상 1개 이상 있다. 없으면 필드 자체가 없다. 엔진이 스스로 차단할 때(허용 대상 교집합 공백)는 \`resolve_target_conflict\` / \`manual_target_recovery\` 가 들어간다.
   - \`rules[].result\` 는 \`matched\` / \`not_matched\` / \`matched_after_block\` 세 가지다. \`block\`(롤백은 \`manual_recovery\`)이 나와도 엔진은 끝까지 평가해 targets 좁히기와 해결 조건을 모두 모으므로, 차단 뒤에 걸린 규칙은 \`matched_after_block\` 으로 온다. 이 규칙들은 decision 을 바꾸지 않았다. 유일한 예외는 \`halt: true\` 인 규칙(현재 R2 입력 불일치)과 롤백의 \`keep_stable\`: 그 자리에서 멈추고 뒤 규칙은 목록에 없다.
   - \`rules[].reason_i18n\` / \`requires[].hint_i18n\` (선택, \`{ ja }\`): 규정집(policy.yaml)의 reason 과 hint 를 \`{ ko, ja }\` 로 적으면 결정서의 \`reason\` / \`hint\` 는 ko 문자열 그대로이고, 일본어 문구가 이 필드에 함께 실린다. 정책에 ja 가 없으면 필드 자체가 없다. 결정 설명(\`src/explain.ts --lang ja\`)은 이 필드를 쓰고, 없으면 ko 로 대체한다. 결정 로직에는 영향이 없다.
   - **\`allowed_targets\` 는 이 해결 조건과 연결된 정책 위반이 해소됐다고 가정했을 때, 나머지 정책 제약상 가능한 배포 위치다.** 한 규칙이 해결 조건을 여러 개 요구하면 모두 충족해야 하고, 수정 후에는 새 버전으로 전체 정책을 다시 평가한다 (이 값은 예고이지 보증이 아니다). 계산은 그 조건을 요구한 규칙들을 뺀 나머지 걸린 규칙만으로 \`default.targets\`(롤백은 \`stable.targets\`)에서 좁힌 결과이며, 해결 조건마다 다를 수 있다. 예: SQLite 만 걸린 앱의 \`managed_db\` 는 \`["onprem", "cloud_run"]\`(고치면 클라우드도 가능), SQLite + 개인정보 앱의 \`managed_db\` 는 \`["onprem"]\`(개인정보 규칙이 남으므로 관리형 DB 도 온프레여야 하며 Cloud SQL 로 옮기면 안 된다). 나머지 규칙끼리 충돌하면 빈 배열이다. decision 에는 영향이 없다.
   - \`decisions.jsonl\` 의 \`kind\` (\`deploy\` | \`rollback\`): 같은 파일에 두 종류의 결정이 섞이므로 반드시 \`kind\` 로 구분해서 읽을 것. 두 종류는 필드 구성이 다르다.
   - \`rollback_plan.serve_digest\` (string | null): 결정 후 트래픽을 받아야 할 버전. \`keep_stable\`/\`rollback\` 이면 \`stable.digest\`, \`manual_recovery\` 면 null. 배포 파트는 \`decision\` 이 아니라 이 값으로 라우팅 대상을 정하면 된다.
   - \`rollback_request.candidate\` / \`stable\`: 예전 이름 \`current\` / \`previous\` 는 받지 않는다. candidate = 이번 배포 후보(문제가 난 버전), stable = 이번 배포 전 정상 버전.
   - \`failover_allowed\` (plan, rollback_plan): \`onprem\` 과 \`cloud_run\` 이 모두 targets 에 있을 때만 true 가 될 수 있다. 배포 파트는 이 값이 false 면 온프레 장애 시 Cloud Run 으로 넘기지 않는다.
5. **targets 의 값은 policy.yaml 의 \`known_targets\`(현재 \`onprem\`, \`cloud_run\`) 안에서만 나온다.** 배포 파트가 새 대상을 지원하면 \`known_targets\` 에 먼저 추가해야 한다.
   - **\`test_result.facts\` 는 정책이 읽는 키만 타입이 정해져 있다** (\`db\`: \`sqlite\` | \`postgres\` | \`mysql\` | \`none\` 소문자, \`writes_local_file\`: string[], \`migration\`: 파괴적 마이그레이션 판정 \`{ destructive, backward_compatible, findings }\`). 대문자 \`"SQLite"\` 나 숫자는 형식 오류다. 그 밖의 키(예: \`framework\`)는 자유롭게 넣을 수 있고 그대로 보존된다. 정책이 새 키를 읽어야 하면 스키마에 먼저 추가한다 ("정책이 읽는 필드" 표 참고).
   - **\`facts.conditions\` 와 \`facts.storage\` 는 parity 변환기(\`src/adapters/parity.ts\`)가 넣는 조건별 재생 결과와 저장 사실이다.** \`conditions\` 가 있는 입력에서는 \`passed\` 는 테스트 파트 원본의 종합값을 보존하는 필드이고 정책 판단(R1, R1b, R1c)은 조건별 사실을 읽는다. \`conditions\` 가 없는 구형 입력에서만 R1 이 \`passed\` 를 fallback 으로 본다. 없는 값은 null 대신 키를 생략한다.
   - **\`facts.migration\` 은 테스트 파트가 넣어도 되고 비워 둬도 된다.** 비워 두면 보안 단계 실행기(\`src/stage.ts\`)가 앱 폴더의 \`migrations/**/*.sql\` 과 \`prisma/migrations/*/migration.sql\` 을 읽어 판정해 채운다 (\`--since <이름>\` 으로 이미 적용된 마이그레이션은 건너뛴다). 넣어 주면 그 값을 존중한다. 단독 실행은 \`npx tsx src/migration/cli.ts --src <앱> --out migration.json\`. \`destructive: true\` 면 R7 이 차단하고 해결 조건 \`two_phase_migration\` 을 낸다.
6. **decisions.jsonl 은 추가만 한다.** 기존 줄을 고치거나 지우지 않는다. 시간(\`time\`)은 CLI 가 붙이므로 같은 입력으로 다시 돌리면 \`plan_hash\` 는 같고 \`time\` 만 다르다.
7. **파일 형식을 바꾸고 싶으면 \`src/schema.ts\` 를 고치고 \`npm run contracts\` 로 이 문서를 다시 만든다.** 손으로 고친 문서는 다음 생성 때 사라진다.`;

export function renderReadme(contracts: Contract[], schemas: Map<string, JsonSchema>): string {
  const sections = contracts.map((c) => {
    const schema = schemas.get(c.name)!;
    const example = JSON.stringify(c.example(), null, 2);
    return [
      `## ${c.fileName} — ${c.name}`,
      "",
      `- **JSON Schema**: [\`${schemaFileName(c)}\`](./${schemaFileName(c)})`,
      `- **만드는 쪽**: ${c.producer}`,
      `- **쓰는 쪽**: ${c.consumer}`,
      `- **내용**: ${c.purpose}`,
      `- **검증**: \`npx tsx src/validate.ts --type ${c.typeKey} --file <파일>\``,
      "",
      `### 필드`,
      "",
      fieldSection(schema),
      "",
      `### 예시 (${c.exampleSource})`,
      "",
      "```json",
      example,
      "```",
    ].join("\n");
  });

  return [
    "# 파일 계약 (contracts)",
    "",
    "> 이 폴더는 정책 엔진(policy) 기준으로 자동 생성한 **데이터 양식 초안**입니다. 팀 공통 양식은 루트 `contracts/`에서",
    "> 관리하며, 원본 형식과 옮기는 방법은 팀 회의에서 정합니다. 그 전까지 다른 파트는 참고용으로만 봐주세요.",
    "",
    "다른 파트와 주고받는 JSON 파일의 형식. **`npm run contracts` 가 `src/schema.ts` 에서 자동 생성한다. 손으로 고치지 말 것.**",
    "",
    "각 파일의 JSON Schema(draft 2020-12)가 이 폴더에 함께 있다. 어떤 언어에서든 그 스키마로 검증할 수 있고, 이 저장소에서는 다음으로 검증한다.",
    "",
    "```bash",
    "npx tsx src/validate.ts --type test_result --file some.json",
    "```",
    "",
    "`--type` 은 `test_result` | `pii` | `plan` | `rollback_request` | `rollback_plan` | `decision_log`(jsonl, 줄마다 검증) | `policy`(yaml).",
    "",
    "## 흐름",
    "",
    FLOW,
    "",
    "| 파일 | 만드는 쪽 | 쓰는 쪽 |",
    "|---|---|---|",
    ...contracts.map((c) => `| [\`${c.fileName}\`](#${c.fileName.replace(/\./g, "").toLowerCase()}--${c.name.toLowerCase()}) | ${c.producer} | ${c.consumer} |`),
    "",
    "입력 파일(test_result, pii, rollback_request)은 모르는 필드가 있어도 받는다(무시). 출력 파일(plan, rollback_plan, decisions.jsonl)은 적힌 필드만 있고, 추가 필드가 있으면 zod 와 JSON Schema 모두 거부한다.",
    "",
    policyPathsSection(),
    "",
    AGREEMENTS,
    "",
    ...sections.flatMap((s) => [s, ""]),
  ].join("\n");
}
