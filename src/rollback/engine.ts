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
 *                        keep_stable / manual_recovery 가 나오면 그 즉시 멈춘다.
 *   - targets          : stable.targets 에서 시작해 좁히기만 된다. 교집합이 비면 manual_recovery.
 *   - failover_allowed : false 가 이긴다. 최종 targets 에 local 과 cloud_run 이 모두 있을 때만 true 가능.
 *   - 아무 규칙도 decision 을 정하지 않으면 rollback 섹션의 default 를 쓴다 (rules 에 "default" 로 기록).
 *
 * 결과
 *   keep_stable     → serve_digest = stable.digest, targets = 좁혀진 stable.targets
 *   rollback        → serve_digest = stable.digest, targets = 좁혀진 stable.targets
 *   manual_recovery → serve_digest = null,          targets = [], failover_allowed = false
 */
import { FAILOVER_REQUIRED_TARGETS, canonicalize, evaluate, intersect, renderReason, renderTemplate, sha256Hex } from "../engine.js";
import type { Policy, RollbackDecision, RollbackPlan, RollbackRequest, RuleResult } from "../schema.js";

/** 롤백 규칙이 바라보는 루트 컨텍스트 */
export interface RollbackContext {
  request: RollbackRequest;
}

const RANK: Record<RollbackDecision, number> = { rollback: 0, keep_stable: 1, manual_recovery: 2 };
const TERMINAL = new Set<RollbackDecision>(["keep_stable", "manual_recovery"]);

export function escalateRollback(current: RollbackDecision, next: RollbackDecision): RollbackDecision {
  return RANK[next] > RANK[current] ? next : current;
}

export function decideRollback(request: RollbackRequest, policy: Policy): RollbackPlan {
  const section = policy.rollback;
  if (!section) throw new Error("policy.yaml 에 rollback 섹션이 없습니다");

  const root: RollbackContext = { request };
  let decision: RollbackDecision | undefined;
  let targets: string[] = [...request.stable.targets];
  let failoverAllowed: boolean | undefined;
  const rules: RuleResult[] = [];

  for (const rule of section.rules) {
    const result = evaluate(rule.if, root);
    if (!result.matched) {
      rules.push({ id: rule.id, result: "not_matched" });
      continue;
    }

    let reason = renderReason(rule.reason, root, result.items);

    if (rule.then.decision !== undefined) decision = escalateRollback(decision ?? "rollback", rule.then.decision);

    if (rule.then.targets !== undefined) {
      const narrowed = intersect(targets, rule.then.targets);
      if (narrowed.length === 0) {
        decision = "manual_recovery";
        reason += ` → 허용된 복귀 대상이 없음 (지금까지 [${targets.join(", ")}] ∩ 규칙 [${rule.then.targets.join(", ")}] = [])`;
      }
      targets = narrowed;
    }

    if (rule.then.failover_allowed === false) failoverAllowed = false;
    else if (rule.then.failover_allowed === true && failoverAllowed === undefined) failoverAllowed = true;

    rules.push({ id: rule.id, result: "matched", reason });
    if (decision !== undefined && TERMINAL.has(decision)) break;
  }

  if (decision === undefined) {
    decision = section.default.decision;
    rules.push({ id: "default", result: "matched", reason: renderTemplate(section.default.reason, root, root) });
  }

  // 결정 후 누가 트래픽을 받는가. manual_recovery 만 "아무도 아님(사람이 정함)".
  const serveDigest = decision === "manual_recovery" ? null : request.stable.digest;
  if (decision === "manual_recovery") targets = [];

  // false 가 이긴다. 아무도 정하지 않았으면 default. failover 에 필요한 대상이 빠져 있으면 무조건 false.
  const failoverPossible = FAILOVER_REQUIRED_TARGETS.every((t) => targets.includes(t));
  failoverAllowed = failoverPossible && (failoverAllowed ?? section.default.failover_allowed);

  const body: Omit<RollbackPlan, "plan_hash"> = {
    run_id: request.run_id,
    app: request.app,
    decision,
    serve_digest: serveDigest,
    targets,
    failover_allowed: failoverAllowed,
    rules,
  };
  const plan_hash = sha256Hex(canonicalize({ request, policy: section, plan: body }));
  return { ...body, plan_hash };
}
