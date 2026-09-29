/**
 * 정책 엔진의 핵심: decide(testResult, pii, policy) -> plan
 *
 * - 파일 입출력, 시간, 난수, 네트워크를 쓰지 않는 순수 함수다.
 *   (node:crypto 의 sha256 은 결정적이라 예외로 쓴다)
 * - 같은 입력이면 항상 같은 plan (같은 plan_hash) 이 나온다.
 * - 규칙 내용은 policy.yaml 에 있고, 여기서는 조건 DSL 만 해석한다.
 */
import { createHash } from "node:crypto";
import type {
  Condition,
  Decision,
  JsonPrimitive,
  PiiReport,
  Plan,
  Policy,
  RuleResult,
  TestResult,
} from "./schema.js";

/** 규칙 조건이 바라보는 루트 컨텍스트 */
export interface Context {
  test: TestResult;
  pii: PiiReport;
}

// ---------------------------------------------------------------------------
// 경로 해석
// ---------------------------------------------------------------------------

/**
 * 점 표기 경로로 값을 꺼낸다. `$.` 로 시작하면 루트 컨텍스트, 아니면 현재 scope 기준.
 * 중간에 값이 없으면 undefined.
 */
export function getPath(root: unknown, scope: unknown, path: string): unknown {
  let cur: unknown = scope;
  let p = path;
  if (p === "$") return root;
  if (p.startsWith("$.")) {
    cur = root;
    p = p.slice(2);
  }
  for (const key of p.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// 조건 평가
// ---------------------------------------------------------------------------

export interface EvalResult {
  matched: boolean;
  /** `some` 조건이 잡아낸 배열 원소들. reason 렌더링에 쓰인다. */
  items: unknown[];
}

function primitiveEquals(a: unknown, b: JsonPrimitive): boolean {
  return a === b;
}

export function evaluate(cond: Condition, root: Context, scope: unknown = root): EvalResult {
  if ("all" in cond) {
    const items: unknown[] = [];
    for (const c of cond.all) {
      const r = evaluate(c, root, scope);
      if (!r.matched) return { matched: false, items: [] };
      items.push(...r.items);
    }
    return { matched: true, items };
  }
  if ("any" in cond) {
    const items: unknown[] = [];
    let matched = false;
    for (const c of cond.any) {
      const r = evaluate(c, root, scope);
      if (r.matched) {
        matched = true;
        items.push(...r.items);
      }
    }
    return { matched, items };
  }
  if ("not" in cond) {
    return { matched: !evaluate(cond.not, root, scope).matched, items: [] };
  }
  if ("some" in cond) {
    const arr = getPath(root, scope, cond.some);
    if (!Array.isArray(arr)) return { matched: false, items: [] };
    const where = cond.where;
    const items = where === undefined ? arr : arr.filter((item) => evaluate(where, root, item).matched);
    return { matched: items.length > 0, items };
  }

  const value = getPath(root, scope, cond.path);
  if ("eq" in cond) return { matched: primitiveEquals(value, cond.eq), items: [] };
  if ("ne" in cond) return { matched: !primitiveEquals(value, cond.ne), items: [] };
  if ("in" in cond) return { matched: cond.in.some((v) => primitiveEquals(value, v)), items: [] };
  if ("gt" in cond) return { matched: typeof value === "number" && value > cond.gt, items: [] };
  if ("lt" in cond) return { matched: typeof value === "number" && value < cond.lt, items: [] };
  if ("exists" in cond) return { matched: (value !== undefined) === cond.exists, items: [] };
  if ("eq_path" in cond) return { matched: value === getPath(root, scope, cond.eq_path), items: [] };
  if ("ne_path" in cond) return { matched: value !== getPath(root, scope, cond.ne_path), items: [] };

  // ConditionSchema 가 통과시킨 값이라면 여기 올 수 없다.
  const never: never = cond;
  throw new Error(`알 수 없는 조건: ${JSON.stringify(never)}`);
}

// ---------------------------------------------------------------------------
// reason 템플릿: "{column}" / "{$.test.run_id}" 를 값으로 치환
// ---------------------------------------------------------------------------

function formatValue(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * `{path}` 는 먼저 scope(배열 원소) 에서 찾고, 없으면 루트({test, pii}) 에서 찾는다.
 * `{$.path}` 는 항상 루트.
 */
export function renderTemplate(template: string, root: Context, scope: unknown): string {
  return template.replace(/\{([^{}]+)\}/g, (_m, rawPath: string) => {
    const path = rawPath.trim();
    const fromScope = getPath(root, scope, path);
    const value = fromScope !== undefined || path.startsWith("$") ? fromScope : getPath(root, root, path);
    return formatValue(value);
  });
}

/**
 * `some` 으로 잡힌 원소가 있으면 원소마다 한 번씩 렌더링해 "; " 로 잇는다.
 * 없으면 루트 컨텍스트 기준으로 한 번만 렌더링한다.
 */
export function renderReason(template: string, root: Context, items: unknown[]): string {
  if (items.length === 0) return renderTemplate(template, root, root);
  return items.map((item) => renderTemplate(template, root, item)).join("; ");
}

// ---------------------------------------------------------------------------
// 결정 병합: allow < needs_approval < block (강한 쪽만 남는다)
// ---------------------------------------------------------------------------

const DECISION_RANK: Record<Decision, number> = { allow: 0, needs_approval: 1, block: 2 };

export function escalate(current: Decision, next: Decision): Decision {
  return DECISION_RANK[next] > DECISION_RANK[current] ? next : current;
}

// ---------------------------------------------------------------------------
// 정규화 + 해시
// ---------------------------------------------------------------------------

/** 키를 정렬한 결정적 JSON 문자열 */
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

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

/**
 * 규칙을 위에서부터 차례로 검사한다.
 * - 걸린 규칙의 then 을 누적 적용한다 (targets / failover_allowed 는 나중 규칙이 덮어쓴다).
 * - decision 은 강한 쪽으로만 올라간다 (allow < needs_approval < block).
 * - block 이 나오면 그 즉시 멈춘다. 이후 규칙은 plan.rules 에 실리지 않는다.
 * - 아무 규칙도 targets 를 정하지 않았으면 policy.default 를 쓴다 (rules 에 id "default" 로 기록).
 */
export function decide(test: TestResult, pii: PiiReport, policy: Policy): Plan {
  const root: Context = { test, pii };

  let decision: Decision = "allow";
  let targets: string[] | undefined;
  let failoverAllowed: boolean | undefined;
  const rules: RuleResult[] = [];

  for (const rule of policy.rules) {
    const result = evaluate(rule.if, root);
    if (!result.matched) {
      rules.push({ id: rule.id, result: "not_matched" });
      continue;
    }

    rules.push({ id: rule.id, result: "matched", reason: renderReason(rule.reason, root, result.items) });

    if (rule.then.decision !== undefined) decision = escalate(decision, rule.then.decision);
    if (rule.then.targets !== undefined) targets = [...rule.then.targets];
    if (rule.then.failover_allowed !== undefined) failoverAllowed = rule.then.failover_allowed;

    if (decision === "block") break;
  }

  if (decision === "block") {
    // 차단이면 배포 위치는 없다.
    targets = [];
    failoverAllowed = false;
  } else if (targets === undefined) {
    targets = [...policy.default.targets];
    failoverAllowed = failoverAllowed ?? policy.default.failover_allowed;
    rules.push({ id: "default", result: "matched", reason: renderTemplate(policy.default.reason, root, root) });
  } else {
    failoverAllowed = failoverAllowed ?? policy.default.failover_allowed;
  }

  const body: Omit<Plan, "plan_hash"> = {
    run_id: test.run_id,
    app: test.app,
    digest: test.digest,
    decision,
    targets,
    failover_allowed: failoverAllowed,
    rules,
  };

  // 입력(test, pii, policy) 과 결과를 함께 정규화해 해시한다.
  // -> 입력이 하나라도 바뀌면 hash 가 바뀌고, 같은 입력이면 항상 같다.
  const plan_hash = sha256Hex(canonicalize({ inputs: { test, pii }, policy, plan: body }));
  return { ...body, plan_hash };
}
