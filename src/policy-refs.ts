/**
 * policy.yaml 의 규칙들이 실제로 어떤 경로를 읽는지 모은다.
 *
 * - 계약 문서(contracts/README.md)의 "정책이 읽는 필드" 표를 만드는 데 쓴다.
 * - 규칙이 스키마에 정의되지 않은 facts 키를 참조하면 경고를 만든다 (정책 로드 시 출력).
 *
 * 경로 표기: 조건의 path 그대로. `some` 안의 where 는 원소 기준이므로 `<배열 경로>[].<path>` 로 적는다.
 */
import { type Condition, type I18nText, KNOWN_FACTS_KEYS, type Policy } from "./schema.js";

export interface PathRef {
  path: string;
  /** 어떤 규칙이 읽는지 */
  rules: string[];
  /** 조건(if)에서 읽는지, reason 템플릿에서 읽는지 */
  uses: Array<"condition" | "reason">;
}

type Section = "deploy" | "rollback";

interface RefCollector {
  add(path: string, rule: string, use: "condition" | "reason"): void;
}

/** scope 기준 경로를 루트 기준 표기로 바꾼다. scope 가 없으면 그대로. `@` 는 원소 자체 → `배열[]` */
function absolute(path: string, scopePrefix: string | undefined): string {
  if (path === "$") return "$";
  if (path.startsWith("$.")) return path.slice(2);
  if (path === "@") return scopePrefix ? `${scopePrefix}[]` : "@";
  if (path.startsWith("@.")) return scopePrefix ? `${scopePrefix}[].${path.slice(2)}` : path.slice(2);
  return scopePrefix ? `${scopePrefix}[].${path}` : path;
}

function walkCondition(cond: Condition, rule: string, scopePrefix: string | undefined, out: RefCollector): void {
  if ("all" in cond) return cond.all.forEach((c) => walkCondition(c, rule, scopePrefix, out));
  if ("any" in cond) return cond.any.forEach((c) => walkCondition(c, rule, scopePrefix, out));
  if ("not" in cond) return walkCondition(cond.not, rule, scopePrefix, out);
  if ("some" in cond) {
    const arrayPath = absolute(cond.some, scopePrefix);
    out.add(arrayPath, rule, "condition");
    if (cond.where) walkCondition(cond.where, rule, arrayPath, out);
    return;
  }
  out.add(absolute(cond.path, scopePrefix), rule, "condition");
  if ("eq_path" in cond) out.add(absolute(cond.eq_path, scopePrefix), rule, "condition");
  if ("ne_path" in cond) out.add(absolute(cond.ne_path, scopePrefix), rule, "condition");
}

/** reason 템플릿의 {경로}. some 이 있는 규칙이면 원소 기준일 수 있어 그 접두어를 붙인다 (없는 경로는 루트로 폴백하므로 둘 다 적는다) */
function walkReason(template: string, rule: string, somePrefix: string | undefined, out: RefCollector): void {
  for (const m of template.matchAll(/\{([^{}]+)\}/g)) {
    const path = m[1]!.trim();
    if (path.startsWith("$")) {
      out.add(absolute(path, undefined), rule, "reason");
    } else if (somePrefix) {
      out.add(absolute(path, somePrefix), rule, "reason");
    } else {
      out.add(path, rule, "reason");
    }
  }
}

function firstSomePath(cond: Condition): string | undefined {
  if ("some" in cond) return cond.some;
  if ("all" in cond) return cond.all.map(firstSomePath).find(Boolean);
  if ("any" in cond) return cond.any.map(firstSomePath).find(Boolean);
  if ("not" in cond) return firstSomePath(cond.not);
  return undefined;
}

/** reason 은 { ko, ja? } 이므로 두 언어의 템플릿을 모두 본다 */
function walkI18nReason(text: I18nText, rule: string, somePrefix: string | undefined, out: RefCollector): void {
  walkReason(text.ko, rule, somePrefix, out);
  if (text.ja !== undefined) walkReason(text.ja, rule, somePrefix, out);
}

function collect(rules: ReadonlyArray<{ id: string; if: Condition; reason: I18nText }>, defaultReason: I18nText): PathRef[] {
  const map = new Map<string, PathRef>();
  const out: RefCollector = {
    add(path, rule, use) {
      const ref = map.get(path) ?? { path, rules: [], uses: [] };
      if (!ref.rules.includes(rule)) ref.rules.push(rule);
      if (!ref.uses.includes(use)) ref.uses.push(use);
      map.set(path, ref);
    },
  };
  for (const rule of rules) {
    walkCondition(rule.if, rule.id, undefined, out);
    walkI18nReason(rule.reason, rule.id, firstSomePath(rule.if), out);
  }
  walkI18nReason(defaultReason, "default", undefined, out);
  return [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 배포 규칙과 롤백 규칙이 읽는 경로. 배포 규칙의 루트는 { test, pii }, 롤백 규칙의 루트는 { request } */
export function collectPolicyPaths(policy: Policy): Record<Section, PathRef[]> {
  return {
    deploy: collect(policy.rules, policy.default.reason),
    rollback: policy.rollback ? collect(policy.rollback.rules, policy.rollback.default.reason) : [],
  };
}

/**
 * 정책이 스키마에 없는 facts 키를 참조하면 경고. 규칙 내용 자체는 막지 않는다 (경고만).
 * 예: `test.facts.framework` 를 읽는 규칙 → "규칙 X 가 정의되지 않은 facts 키를 읽습니다: framework"
 */
export function lintPolicy(policy: Policy): string[] {
  const warnings: string[] = [];
  const known = new Set(KNOWN_FACTS_KEYS);
  for (const ref of collectPolicyPaths(policy).deploy) {
    const m = /^test\.facts\.([^.[\]]+)/.exec(ref.path);
    if (m && !known.has(m[1]!)) {
      warnings.push(
        `규칙 ${ref.rules.join(", ")} 이(가) 정의되지 않은 facts 키를 읽습니다: ${m[1]} (경로 ${ref.path}). ` +
          `test_result.facts 에 타입이 정해진 키는 ${KNOWN_FACTS_KEYS.join(", ")} 뿐입니다. src/schema.ts 의 FactsSchema 에 추가하세요`,
      );
    }
  }
  return warnings;
}
