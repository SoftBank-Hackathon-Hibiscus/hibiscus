/**
 * 정책 인식 롤백: decideRollback(request, policy) -> rollback_plan
 *
 * 배포 후 문제가 생겼을 때 "되돌려도 되는가, 어디로 되돌리는가" 를 규칙으로 판단한다.
 * 실제 롤백 실행은 배포 파트가 한다. 여기서는 판단만 하고, 파일·시간·난수를 쓰지 않는다.
 *
 * 용어
 *   candidate : 이번 배포 후보 (문제가 난 버전)
 *   stable    : 이번 배포 전 정상 버전 (되돌아갈 곳)
 *
 * 병합 규칙 (배포 엔진과 같은 원칙: 안전한 쪽으로만 움직인다)
 *   - decision         : rollback < keep_stable < manual_recovery 순으로 강한 쪽만 남는다.
 *                        keep_stable 은 되돌릴 것이 없으므로 그 즉시 멈춘다.
 *                        manual_recovery 는 halt 가 아니면 끝까지 평가한다: 뒤 규칙은 decision 을 못 바꾸고
 *                        targets 좁히기와 해결 조건만 반영되며 "matched_after_block" 으로 기록된다.
 *                        halt: true 인 규칙이 걸리면 그 즉시 멈춘다.
 *   - targets          : stable.targets 에서 시작해 좁히기만 된다. 교집합이 비면 manual_recovery.
 *   - failover_allowed : false 가 이긴다. 최종 targets 에 onprem 과 cloud_run 이 모두 있을 때만 true 가능.
 *   - 아무 규칙도 decision 을 정하지 않으면 rollback 섹션의 default 를 쓴다 (rules 에 "default" 로 기록).
 *   - requires(해결 조건) 는 배포 엔진과 같이 id 로 합치고 정렬한다. manual_recovery 면 최소 1개 (규칙이 적거나 엔진이 넣음).
 *     allowed_targets 는 그 조건을 요구한 규칙을 뺀 나머지 걸린 규칙만으로 stable.targets 에서 좁힌 결과.
 *
 * 결과
 *   keep_stable     → serve_digest = stable.digest, targets = 좁혀진 stable.targets
 *   rollback        → serve_digest = stable.digest, targets = 좁혀진 stable.targets
 *   manual_recovery → serve_digest = null,          targets = [], failover_allowed = false
 */
import { FAILOVER_REQUIRED_TARGETS, RequirementCollector, type Suffix, appendSuffix, canonicalize, evaluate, intersect, narrowWithout, renderI18nReason, sha256Hex } from "../engine.js";
import type { Policy, Requirement, RollbackDecision, RollbackPlan, RollbackRequest, RuleResult } from "../schema.js";

/** 복귀 대상의 교집합이 비어 엔진이 스스로 manual_recovery 로 갈 때 넣는 해결 조건 */
export const TARGET_CONFLICT_RECOVERY: Requirement = {
  id: "manual_target_recovery",
  hint: {
    ko: "정상 버전의 대상과 롤백 규칙이 허용하는 대상의 교집합이 비어 있음. 사람이 복귀 대상을 정해 복구한다",
    ja: "正常稼働中のバージョンのデプロイ先とロールバックルールが許容するデプロイ先の共通部分が空。人が復帰先を決めて復旧する",
  },
};

const RECOVERY_CONFLICT_SUFFIX: Suffix = {
  ko: (prev, rule) => ` → 허용된 복귀 대상이 없음 (지금까지 [${prev}] ∩ 규칙 [${rule}] = [])`,
  ja: (prev, rule) => `→許容される復帰先がありません（これまで[${prev}]∩ルール[${rule}]=[]）`,
};

/** 롤백 규칙이 바라보는 루트 컨텍스트 */
export interface RollbackContext {
  request: RollbackRequest;
}

const RANK: Record<RollbackDecision, number> = { rollback: 0, keep_stable: 1, manual_recovery: 2 };

export function escalateRollback(current: RollbackDecision, next: RollbackDecision): RollbackDecision {
  return RANK[next] > RANK[current] ? next : current;
}

/** 요청의 candidate·stable targets 가 정책의 known_targets 안에 있는지. 아니면 Error */
export function assertKnownTargets(request: RollbackRequest, policy: Policy): void {
  const known = new Set(policy.known_targets);
  for (const [where, targets] of [
    ["candidate", request.candidate.targets],
    ["stable", request.stable.targets],
  ] as const) {
    const unknown = targets.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      throw new Error(`알 수 없는 배포 대상: ${unknown.join(", ")} (rollback_request.${where}.targets). known_targets: ${policy.known_targets.join(", ")}`);
    }
  }
}

export function decideRollback(request: RollbackRequest, policy: Policy): RollbackPlan {
  const section = policy.rollback;
  if (!section) throw new Error("policy.yaml 에 rollback 섹션이 없습니다");
  assertKnownTargets(request, policy);

  const root: RollbackContext = { request };
  let decision: RollbackDecision | undefined;
  let targets: string[] = [...request.stable.targets];
  let failoverAllowed: boolean | undefined;
  const rules: RuleResult[] = [];
  const requires = new RequirementCollector();
  const matchedRules: NonNullable<Policy["rollback"]>["rules"] = [];

  for (const rule of section.rules) {
    const result = evaluate(rule.if, root);
    if (!result.matched) {
      rules.push({ id: rule.id, result: "not_matched" });
      continue;
    }

    matchedRules.push(rule);
    let rendered = renderI18nReason(rule.reason, root, result.items);
    // 이미 manual_recovery 면 뒤 규칙은 decision 을 바꾸지 못한다. targets 좁히기와 해결 조건만 반영한다.
    const afterTerminal = decision === "manual_recovery";

    if (!afterTerminal && rule.then.decision !== undefined) decision = escalateRollback(decision ?? "rollback", rule.then.decision);
    requires.addAll(rule.then.requires, rule.id);

    if (rule.then.targets !== undefined && targets.length > 0) {
      const narrowed = intersect(targets, rule.then.targets);
      if (narrowed.length === 0) {
        decision = "manual_recovery";
        rendered = appendSuffix(rendered, RECOVERY_CONFLICT_SUFFIX, targets, rule.then.targets);
        requires.add(TARGET_CONFLICT_RECOVERY, rule.id);
      }
      targets = narrowed;
    }

    if (rule.then.failover_allowed === false) failoverAllowed = false;
    else if (rule.then.failover_allowed === true && failoverAllowed === undefined) failoverAllowed = true;

    rules.push({ id: rule.id, result: afterTerminal ? "matched_after_block" : "matched", ...rendered });
    if (decision === "keep_stable" || rule.halt) break;
  }

  if (decision === undefined) {
    decision = section.default.decision;
    rules.push({ id: "default", result: "matched", ...renderI18nReason(section.default.reason, root, []) });
  }

  // 결정 후 누가 트래픽을 받는가. manual_recovery 만 "아무도 아님(사람이 정함)".
  const serveDigest = decision === "manual_recovery" ? null : request.stable.digest;
  if (decision === "manual_recovery") targets = [];

  // false 가 이긴다. 아무도 정하지 않았으면 default. failover 에 필요한 대상이 빠져 있으면 무조건 false.
  const failoverPossible = FAILOVER_REQUIRED_TARGETS.every((t) => targets.includes(t));
  failoverAllowed = failoverPossible && (failoverAllowed ?? section.default.failover_allowed);

  // 해결 조건의 allowed_targets: 그 조건을 요구한 규칙들을 빼고 나머지 걸린 규칙만으로 stable.targets 에서 다시 좁힌 결과
  const requiresList = requires.toList((requesters) => narrowWithout(request.stable.targets, matchedRules, requesters));

  const body: Omit<RollbackPlan, "plan_hash"> = {
    run_id: request.run_id,
    app: request.app,
    decision,
    serve_digest: serveDigest,
    targets,
    failover_allowed: failoverAllowed,
    ...(requiresList ? { requires: requiresList } : {}),
    rules,
  };
  const plan_hash = sha256Hex(canonicalize({ request, policy: section, plan: body }));
  return { ...body, plan_hash };
}
