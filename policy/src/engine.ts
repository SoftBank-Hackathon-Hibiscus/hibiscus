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
  I18nText,
  JsonPrimitive,
  PiiReport,
  Plan,
  PlanRequirement,
  Policy,
  Requirement,
  RuleResult,
  TestResult,
} from "./schema.js";

/** 배포 규칙이 바라보는 루트 컨텍스트. 조건 DSL(evaluate/renderTemplate) 자체는 어떤 루트 객체든 받는다 (롤백 엔진도 재사용) */
export interface Context {
  test: TestResult;
  pii: PiiReport;
}

// ---------------------------------------------------------------------------
// 경로 해석
// ---------------------------------------------------------------------------

/**
 * 점 표기 경로로 값을 꺼낸다. `$.` 로 시작하면 루트 컨텍스트, 아니면 현재 scope 기준.
 * `@` 는 현재 scope 값 자체 (some 의 원소가 문자열일 때 그 문자열). `@.x` 는 원소의 x.
 * 중간에 값이 없으면 undefined.
 */
export function getPath(root: unknown, scope: unknown, path: string): unknown {
  let cur: unknown = scope;
  let p = path;
  if (p === "$") return root;
  if (p === "@") return scope;
  if (p.startsWith("$.")) {
    cur = root;
    p = p.slice(2);
  } else if (p.startsWith("@.")) {
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

export function evaluate(cond: Condition, root: object, scope: unknown = root): EvalResult {
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
  if ("starts_with" in cond) return { matched: typeof value === "string" && value.startsWith(cond.starts_with), items: [] };
  if ("matches" in cond) return { matched: typeof value === "string" && new RegExp(cond.matches, cond.flags).test(value), items: [] };
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
export function renderTemplate(template: string, root: object, scope: unknown): string {
  return template.replace(/\{([^{}]+)\}/g, (_m, rawPath: string) => {
    const path = rawPath.trim();
    const fromScope = getPath(root, scope, path);
    const value = fromScope !== undefined || path.startsWith("$") || path.startsWith("@") ? fromScope : getPath(root, root, path);
    return formatValue(value);
  });
}

// ---------------------------------------------------------------------------
// 해결 조건(requires) 모으기: id 로 합치고 (먼저 요구한 규칙이 남는다) id 순 정렬
// ---------------------------------------------------------------------------

export class RequirementCollector {
  private readonly map = new Map<string, Omit<PlanRequirement, "allowed_targets">>();
  /** 해결 조건 id → 그것을 요구한 모든 규칙 id (첫 규칙뿐 아니라 전부) */
  private readonly requesters = new Map<string, Set<string>>();

  add(req: Requirement, ruleId: string): void {
    const set = this.requesters.get(req.id) ?? new Set<string>();
    set.add(ruleId);
    this.requesters.set(req.id, set);
    if (this.map.has(req.id)) return;
    this.map.set(req.id, {
      id: req.id,
      ...(req.hint !== undefined ? { hint: req.hint.ko } : {}),
      ...(req.hint?.ja !== undefined ? { hint_i18n: { ja: req.hint.ja } } : {}),
      rule_id: ruleId,
    });
  }

  addAll(reqs: readonly Requirement[] | undefined, ruleId: string): void {
    for (const r of reqs ?? []) this.add(r, ruleId);
  }

  /**
   * id 순 정렬. 하나도 없으면 undefined (plan 에 필드를 싣지 않는다).
   * allowedFor(요구한 규칙 id 들): 그 규칙들을 제외하고 나머지 걸린 규칙만으로 좁힌 targets
   *   = "이 해결 조건을 충족하면 배포 가능한 위치"
   */
  toList(allowedFor: (requesters: ReadonlySet<string>) => string[]): PlanRequirement[] | undefined {
    if (this.map.size === 0) return undefined;
    return [...this.map.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({ ...r, allowed_targets: allowedFor(this.requesters.get(r.id) ?? new Set()) }));
  }
}

/**
 * 걸린 규칙 중 excluded 를 뺀 나머지만으로 base 에서 시작해 좁힌 targets.
 * 해결 조건의 allowed_targets 계산에 쓴다 (두 번째 패스. decision 에는 영향 없음).
 * 나머지 규칙끼리 충돌하면 빈 배열이 될 수 있다.
 */
export function narrowWithout(
  base: readonly string[],
  matchedRules: ReadonlyArray<{ id: string; then: { targets?: readonly string[] } }>,
  excluded: ReadonlySet<string>,
): string[] {
  let targets = [...base];
  for (const rule of matchedRules) {
    if (excluded.has(rule.id) || rule.then.targets === undefined) continue;
    targets = intersect(targets, rule.then.targets);
  }
  return targets;
}

/** 규칙들이 허용하는 대상의 교집합이 비어 엔진이 스스로 차단할 때 넣는 해결 조건 */
export const TARGET_CONFLICT_REQUIREMENT: Requirement = {
  id: "resolve_target_conflict",
  hint: {
    ko: "규칙들이 허용하는 배포 대상의 교집합이 비어 있음. 정책 또는 앱을 조정해 한 대상이라도 남게 한다",
    ja: "ルールが許容するデプロイ先の共通部分が空。ポリシーまたはアプリを調整し、少なくとも1つのデプロイ先を残す",
  },
};

/**
 * `some` 으로 잡힌 원소가 있으면 원소마다 한 번씩 렌더링해 "; " 로 잇는다.
 * 없으면 루트 컨텍스트 기준으로 한 번만 렌더링한다.
 */
export function renderReason(template: string, root: object, items: unknown[]): string {
  if (items.length === 0) return renderTemplate(template, root, root);
  return items.map((item) => renderTemplate(template, root, item)).join("; ");
}

/** 렌더링된 근거: ko 본문 + (정책에 ja 가 있으면) reason_i18n */
export interface RenderedReason {
  reason: string;
  reason_i18n?: { ja: string };
}

export function renderI18nReason(text: I18nText, root: object, items: unknown[]): RenderedReason {
  const reason = renderReason(text.ko, root, items);
  return text.ja !== undefined ? { reason, reason_i18n: { ja: renderReason(text.ja, root, items) } } : { reason };
}

/** 엔진이 스스로 붙이는 문구 (교집합 공백). 두 언어 모두 준비한다 */
export type Suffix = { ko: (prev: string, rule: string) => string; ja: (prev: string, rule: string) => string };

export function appendSuffix(rendered: RenderedReason, suffix: Suffix, prev: readonly string[], rule: readonly string[]): RenderedReason {
  const out: RenderedReason = { reason: rendered.reason + suffix.ko(prev.join(", "), rule.join(", ")) };
  if (rendered.reason_i18n) out.reason_i18n = { ja: rendered.reason_i18n.ja + suffix.ja(prev.join(", "), rule.join(", ")) };
  return out;
}

export const TARGET_CONFLICT_SUFFIX: Suffix = {
  ko: (prev, rule) => ` → 허용된 배포 대상이 없음 (지금까지 [${prev}] ∩ 규칙 [${rule}] = [])`,
  ja: (prev, rule) => `→許容されるデプロイ先がありません（これまで[${prev}]∩ルール[${rule}]=[]）`,
};

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
 * failover 는 "온프레 장애 시 Cloud Run 으로 전환" 을 뜻하므로
 * 이 두 대상이 모두 배포 대상일 때만 의미가 있다.
 */
export const FAILOVER_REQUIRED_TARGETS = ["onprem", "cloud_run"] as const;

/**
 * 결정 기록(decisions.jsonl)의 rule_ids: 걸린 규칙 전부 (matched 와 matched_after_block), 구분 없이 id 만.
 * 정책 CLI, 롤백 CLI, 실행기가 모두 이 함수를 쓴다.
 */
export function matchedRuleIds(rules: readonly RuleResult[]): string[] {
  return rules.filter((r) => r.result !== "not_matched").map((r) => r.id);
}

/** 앞 목록의 순서를 유지한 채 교집합을 구한다. */
export function intersect(current: readonly string[], next: readonly string[]): string[] {
  const allowed = new Set(next);
  return current.filter((t) => allowed.has(t));
}

/**
 * 규칙을 위에서부터 차례로 검사한다.
 * - decision 은 강한 쪽으로만 올라간다 (allow < needs_approval < block).
 * - targets 는 policy.default.targets 에서 시작해 좁히기만 된다: 규칙이 targets 를 정하면
 *   지금까지의 targets 와 교집합만 남긴다. 그래서 default 에 없는 대상은 어떤 규칙으로도
 *   추가할 수 없고, 한 번 제외된 대상은 뒤 규칙이 다시 넣을 수 없다. 교집합이 비면 block.
 * - failover_allowed 는 false 가 이긴다: 한 번 false 면 뒤에서 true 로 못 돌린다.
 *   최종 targets 에 onprem 과 cloud_run 이 모두 없으면 항상 false.
 * - block 이 나와도 끝까지 평가한다. 뒤 규칙은 decision 을 바꾸지 못하고 targets 좁히기와
 *   해결 조건 수집만 반영되며 rules 에 "matched_after_block" 으로 기록된다.
 *   halt: true 인 규칙이 걸리면 그 즉시 멈춘다 (이후 규칙은 rules 에 실리지 않는다).
 * - 아무 규칙도 targets 를 정하지 않았으면 policy.default 를 쓴다 (rules 에 id "default" 로 기록).
 * - requires(해결 조건) 는 걸린 규칙들의 것을 id 로 합치고 정렬한다. 비어 있으면 plan 에 싣지 않는다.
 *   교집합 공백으로 엔진이 스스로 block 할 때는 resolve_target_conflict 를 넣는다.
 *   각 해결 조건의 allowed_targets 는 "그 조건을 요구한 규칙들을 뺀 나머지 걸린 규칙만으로 default.targets 에서
 *   좁힌 결과" = 이 조건을 충족하면 배포 가능한 위치 (두 번째 패스, decision 에 영향 없음).
 */
export function decide(test: TestResult, pii: PiiReport, policy: Policy): Plan {
  const root: Context = { test, pii };

  let decision: Decision = "allow";
  let targets: string[] = [...policy.default.targets];
  let narrowedByRule = false;
  let failoverAllowed: boolean | undefined;
  const rules: RuleResult[] = [];
  const requires = new RequirementCollector();
  /** 걸린 규칙(순서대로). 해결 조건의 allowed_targets 를 두 번째 패스로 계산할 때 쓴다 */
  const matchedRules: Policy["rules"] = [];

  for (const rule of policy.rules) {
    const result = evaluate(rule.if, root);
    if (!result.matched) {
      rules.push({ id: rule.id, result: "not_matched" });
      continue;
    }

    matchedRules.push(rule);
    let rendered = renderI18nReason(rule.reason, root, result.items);
    // 이미 block 이면 뒤 규칙은 decision 을 바꾸지 못한다. targets 좁히기와 해결 조건만 반영한다.
    const afterBlock = decision === "block";

    if (!afterBlock && rule.then.decision !== undefined) decision = escalate(decision, rule.then.decision);
    requires.addAll(rule.then.requires, rule.id);

    // targets 가 이미 비었으면(교집합 공백) 더 좁힐 것이 없다
    if (rule.then.targets !== undefined && targets.length > 0) {
      const narrowed = intersect(targets, rule.then.targets);
      if (narrowed.length === 0) {
        decision = "block";
        rendered = appendSuffix(rendered, TARGET_CONFLICT_SUFFIX, targets, rule.then.targets);
        requires.add(TARGET_CONFLICT_REQUIREMENT, rule.id);
      }
      targets = narrowed;
      narrowedByRule = true;
    }

    if (rule.then.failover_allowed === false) failoverAllowed = false;
    else if (rule.then.failover_allowed === true && failoverAllowed === undefined) failoverAllowed = true;

    rules.push({ id: rule.id, result: afterBlock ? "matched_after_block" : "matched", ...rendered });

    if (rule.halt) break;
  }

  if (decision === "block") {
    // 차단이면 배포 위치는 없다.
    targets = [];
  } else if (!narrowedByRule) {
    // 어떤 규칙도 targets 를 정하지 않았다: default 가 그대로 쓰였음을 기록한다.
    rules.push({ id: "default", result: "matched", ...renderI18nReason(policy.default.reason, root, []) });
  }

  // false 가 이긴다. 아무도 정하지 않았으면 default. failover 에 필요한 대상이 빠져 있으면 무조건 false.
  const failoverPossible = FAILOVER_REQUIRED_TARGETS.every((t) => targets.includes(t));
  failoverAllowed = failoverPossible && (failoverAllowed ?? policy.default.failover_allowed);

  // 해결 조건의 allowed_targets: 그 조건을 요구한 규칙들을 빼고 나머지 걸린 규칙만으로 다시 좁힌 결과
  // = "이 조건을 충족하면 배포 가능한 위치". decision 에는 영향이 없다.
  const requiresList = requires.toList((requesters) => narrowWithout(policy.default.targets, matchedRules, requesters));

  const body: Omit<Plan, "plan_hash"> = {
    run_id: test.run_id,
    app: test.app,
    digest: test.digest,
    // 커밋 SHA 는 입력에 있을 때만 그대로 싣는다 (없으면 필드 자체가 없어 기존 plan_hash 가 바뀌지 않는다)
    ...(test.source_revision !== undefined ? { source_revision: test.source_revision } : {}),
    decision,
    targets,
    failover_allowed: failoverAllowed,
    // 걸린 규칙들의 해결 조건. "무엇을 고쳐야 다른 대상에 갈 수 있는지" 를 다음 단계에 알린다
    ...(requiresList ? { requires: requiresList } : {}),
    rules,
  };

  // 입력(test, pii, policy) 과 결과를 함께 정규화해 해시한다.
  // -> 입력이 하나라도 바뀌면 hash 가 바뀌고, 같은 입력이면 항상 같다 (source_revision 도 test 에 실려 반영된다).
  const plan_hash = sha256Hex(canonicalize({ inputs: { test, pii }, policy, plan: body }));
  return { ...body, plan_hash };
}
