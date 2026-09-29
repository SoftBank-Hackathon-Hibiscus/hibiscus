/**
 * 결정 설명: plan.json / rollback_plan.json 을 사람이 읽는 Markdown 문장으로 바꾼다.
 *
 * - 순수 함수. 같은 입력이면 같은 출력. 엔진 결과를 바꾸지 않는다.
 * - 규칙 id(R1 등)는 괄호로만 보조 표시하고 본문은 사람이 읽는 문장으로 쓴다.
 * - lang: ko(기본) | ja
 */
import type { Plan, PlanRequirement, RollbackPlan, RuleResult } from "./schema.js";

export type Lang = "ko" | "ja";
export interface ExplainOptions {
  lang?: Lang;
}

const LOCAL = "local";
const CLOUD = "cloud_run";
const SHORT = 12;

interface Strings {
  targetName: Record<string, string>;
  and: string;
  none: string;
  deployTitle: (app: string, runId: string) => string;
  rollbackTitle: (app: string, runId: string) => string;
  conclusion: Record<Plan["decision"], (targets: string) => string>;
  rollbackConclusion: Record<RollbackPlan["decision"], (serve: string, targets: string) => string>;
  failover: {
    on: string;
    offForbidden: string;
    offNoCloud: string;
    offNoLocal: string;
    offBlocked: string;
    offManual: string;
  };
  reasonsHeading: string;
  reasonsNone: string;
  defaultPolicy: (reason: string) => string;
  afterBlockHeading: string;
  afterManualHeading: string;
  afterNote: string;
  ruleTag: (id: string) => string;
  requiresHeading: string;
  requiresNone: string;
  requirementWhere: (targets: string) => string;
  requirementTag: (ruleId: string, id: string) => string;
  footer: (planHash: string, digestLabel: string, digest: string) => string;
  imageLabel: string;
  serveLabel: string;
  serveNone: string;
}

const STRINGS: Record<Lang, Strings> = {
  ko: {
    targetName: { [LOCAL]: "온프레(사내)", [CLOUD]: "Cloud Run" },
    and: " 및 ",
    none: "없음",
    deployTitle: (app, runId) => `# 배포 결정: ${app} (실행 ${runId})`,
    rollbackTitle: (app, runId) => `# 롤백 결정: ${app} (실행 ${runId})`,
    conclusion: {
      allow: (t) => `**배포 허용.** 이 이미지를 ${t}에 배포합니다.`,
      needs_approval: (t) => `**사람 승인 필요.** 승인되면 ${t}에 배포합니다. 승인 전에는 배포하지 않습니다.`,
      block: () => `**배포 차단.** 이 이미지는 배포하지 않습니다. 아래 해결 조건을 충족한 뒤 다시 테스트해야 합니다.`,
    },
    rollbackConclusion: {
      keep_stable: (serve, t) => `**정상 버전 유지.** 되돌릴 것이 없습니다. 정상 버전(${serve})이 계속 ${t}에서 트래픽을 받습니다.`,
      rollback: (serve, t) => `**롤백.** 정상 버전(${serve})으로 되돌립니다. 되돌리는 위치: ${t}.`,
      manual_recovery: () => `**수동 복구 필요.** 자동으로 되돌릴 수 없습니다. 사람이 아래 해결 조건에 따라 복구해야 하며, 그때까지 트래픽을 받을 버전이 정해지지 않았습니다.`,
    },
    failover: {
      on: "온프레가 멈추면 Cloud Run으로 트래픽을 넘깁니다.",
      offForbidden: "온프레가 멈춰도 Cloud Run으로 넘기지 않습니다 (정책이 금지).",
      offNoCloud: "온프레가 멈춰도 Cloud Run으로 넘기지 않습니다. Cloud Run에는 배포하지 않기 때문입니다.",
      offNoLocal: "Cloud Run에만 배포하므로 온프레 장애 시 전환은 해당 없습니다.",
      offBlocked: "배포하지 않으므로 장애 시 전환도 없습니다.",
      offManual: "수동 복구 전까지 장애 시 전환은 없습니다.",
    },
    reasonsHeading: "## 이유",
    reasonsNone: "걸린 규칙이 없습니다.",
    defaultPolicy: (reason) => `기본 정책을 적용했습니다: ${reason}`,
    afterBlockHeading: "### 차단이 정해진 뒤에 걸린 규칙",
    afterManualHeading: "### 수동 복구가 정해진 뒤에 걸린 규칙",
    afterNote: "결정은 바꾸지 않았고, 배포 위치와 해결 조건에만 반영됐습니다.",
    ruleTag: (id) => `(규칙 ${id})`,
    requiresHeading: "## 해결 조건",
    requiresNone: "해결할 것이 없습니다.",
    requirementWhere: (t) => `충족 위치: ${t} 안에서만`,
    requirementTag: (ruleId, id) => `(규칙 ${ruleId}, \`${id}\`)`,
    footer: (hash, label, digest) => `결정 지문 \`${hash}\` · ${label} \`${digest}\``,
    imageLabel: "이미지",
    serveLabel: "트래픽을 받을 버전",
    serveNone: "미정",
  },
  ja: {
    targetName: { [LOCAL]: "オンプレ(社内)", [CLOUD]: "Cloud Run" },
    and: " と ",
    none: "なし",
    deployTitle: (app, runId) => `# デプロイ判定: ${app} (実行 ${runId})`,
    rollbackTitle: (app, runId) => `# ロールバック判定: ${app} (実行 ${runId})`,
    conclusion: {
      allow: (t) => `**デプロイ許可。** このイメージを ${t} にデプロイします。`,
      needs_approval: (t) => `**人の承認が必要。** 承認されれば ${t} にデプロイします。承認前はデプロイしません。`,
      block: () => `**デプロイ遮断。** このイメージはデプロイしません。下記の解決条件を満たしてから再テストが必要です。`,
    },
    rollbackConclusion: {
      keep_stable: (serve, t) => `**安定版を維持。** 戻すものはありません。安定版(${serve})が引き続き ${t} でトラフィックを受けます。`,
      rollback: (serve, t) => `**ロールバック。** 安定版(${serve})に戻します。戻す場所: ${t}。`,
      manual_recovery: () => `**手動復旧が必要。** 自動では戻せません。下記の解決条件に従って人が復旧する必要があり、それまでトラフィックを受けるバージョンは未定です。`,
    },
    failover: {
      on: "オンプレが停止した場合、Cloud Run にトラフィックを切り替えます。",
      offForbidden: "オンプレが停止しても Cloud Run には切り替えません (ポリシーで禁止)。",
      offNoCloud: "オンプレが停止しても Cloud Run には切り替えません。Cloud Run にはデプロイしないためです。",
      offNoLocal: "Cloud Run のみにデプロイするため、オンプレ障害時の切り替えは対象外です。",
      offBlocked: "デプロイしないため、障害時の切り替えもありません。",
      offManual: "手動復旧までは障害時の切り替えはありません。",
    },
    reasonsHeading: "## 理由",
    reasonsNone: "該当したルールはありません。",
    defaultPolicy: (reason) => `既定ポリシーを適用しました: ${reason}`,
    afterBlockHeading: "### 遮断が決まった後に該当したルール",
    afterManualHeading: "### 手動復旧が決まった後に該当したルール",
    afterNote: "判定は変えず、デプロイ先と解決条件にのみ反映されました。",
    ruleTag: (id) => `(ルール ${id})`,
    requiresHeading: "## 解決条件",
    requiresNone: "解決すべきことはありません。",
    requirementWhere: (t) => `満たす場所: ${t} の中でのみ`,
    requirementTag: (ruleId, id) => `(ルール ${ruleId}, \`${id}\`)`,
    footer: (hash, label, digest) => `判定フィンガープリント \`${hash}\` · ${label} \`${digest}\``,
    imageLabel: "イメージ",
    serveLabel: "トラフィックを受けるバージョン",
    serveNone: "未定",
  },
};

// ---------------------------------------------------------------------------
// 공통 조각
// ---------------------------------------------------------------------------

function targetsText(targets: readonly string[], s: Strings): string {
  if (targets.length === 0) return s.none;
  return targets.map((t) => s.targetName[t] ?? t).join(s.and);
}

/** sha256:abcdef... → sha256:abcdef012345 (앞 12자), 해시는 앞 12자 */
export function shortDigest(digest: string): string {
  const [prefix, hex] = digest.includes(":") ? [digest.slice(0, digest.indexOf(":") + 1), digest.slice(digest.indexOf(":") + 1)] : ["", digest];
  return prefix + hex.slice(0, SHORT);
}
export const shortHash = (hash: string): string => hash.slice(0, SHORT);

function failoverText(decision: string, targets: readonly string[], failoverAllowed: boolean, s: Strings, manual: boolean): string {
  if (decision === "block") return s.failover.offBlocked;
  if (manual) return s.failover.offManual;
  if (failoverAllowed) return s.failover.on;
  const hasLocal = targets.includes(LOCAL);
  const hasCloud = targets.includes(CLOUD);
  if (hasLocal && !hasCloud) return s.failover.offNoCloud;
  if (!hasLocal && hasCloud) return s.failover.offNoLocal;
  return s.failover.offForbidden;
}

function reasonsSection(rules: readonly RuleResult[], s: Strings, afterHeading: string): string[] {
  const lines: string[] = [s.reasonsHeading, ""];
  const matched = rules.filter((r) => r.result === "matched");
  const after = rules.filter((r) => r.result === "matched_after_block");

  if (matched.length === 0) {
    lines.push(`- ${s.reasonsNone}`);
  } else {
    for (const r of matched) {
      if (r.id === "default") lines.push(`- ${s.defaultPolicy(r.reason ?? "")}`);
      else lines.push(`- ${r.reason ?? ""} ${s.ruleTag(r.id)}`);
    }
  }
  if (after.length > 0) {
    lines.push("", afterHeading, "", s.afterNote, "");
    for (const r of after) lines.push(`- ${r.reason ?? ""} ${s.ruleTag(r.id)}`);
  }
  return lines;
}

function requiresSection(requires: readonly PlanRequirement[] | undefined, s: Strings): string[] {
  const lines: string[] = [s.requiresHeading, ""];
  if (!requires || requires.length === 0) {
    lines.push(`- ${s.requiresNone}`);
    return lines;
  }
  for (const r of requires) {
    const what = r.hint ?? r.id;
    lines.push(`- **${what}** — ${s.requirementWhere(targetsText(r.allowed_targets, s))} ${s.requirementTag(r.rule_id, r.id)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// explainPlan / explainRollbackPlan
// ---------------------------------------------------------------------------

export function explainPlan(plan: Plan, opts: ExplainOptions = {}): string {
  const s = STRINGS[opts.lang ?? "ko"];
  const targets = targetsText(plan.targets, s);
  const lines: string[] = [
    s.deployTitle(plan.app, plan.run_id),
    "",
    s.conclusion[plan.decision](targets),
    "",
    failoverText(plan.decision, plan.targets, plan.failover_allowed, s, false),
    "",
    ...reasonsSection(plan.rules, s, s.afterBlockHeading),
    "",
    ...requiresSection(plan.requires, s),
    "",
    "---",
    "",
    s.footer(shortHash(plan.plan_hash), s.imageLabel, shortDigest(plan.digest)),
    "",
  ];
  return lines.join("\n");
}

export function explainRollbackPlan(plan: RollbackPlan, opts: ExplainOptions = {}): string {
  const s = STRINGS[opts.lang ?? "ko"];
  const targets = targetsText(plan.targets, s);
  const serve = plan.serve_digest ? shortDigest(plan.serve_digest) : s.serveNone;
  const manual = plan.decision === "manual_recovery";
  const lines: string[] = [
    s.rollbackTitle(plan.app, plan.run_id),
    "",
    s.rollbackConclusion[plan.decision](serve, targets),
    "",
    failoverText(plan.decision, plan.targets, plan.failover_allowed, s, manual),
    "",
    ...reasonsSection(plan.rules, s, s.afterManualHeading),
    "",
    ...requiresSection(plan.requires, s),
    "",
    "---",
    "",
    s.footer(shortHash(plan.plan_hash), s.serveLabel, serve),
    "",
  ];
  return lines.join("\n");
}

export const LANGS: readonly Lang[] = ["ko", "ja"];
export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}
