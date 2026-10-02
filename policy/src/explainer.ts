/**
 * 결정 설명: plan.json / rollback_plan.json 을 사람이 읽는 Markdown 문장으로 바꾼다.
 *
 * - 순수 함수. 같은 입력이면 같은 출력. 엔진 결과를 바꾸지 않는다.
 * - 규칙 id(R1 등)는 괄호로만 보조 표시하고 본문은 사람이 읽는 문장으로 쓴다.
 * - lang: ko(기본) | ja. 규칙의 reason/hint 는 결정서의 *_i18n 에 해당 언어가 있으면 그것을, 없으면 ko 를 쓴다.
 * - reason/hint 안의 sha256:<64자> 는 앞 12자로 줄인다 (안전장치).
 * - 결정서에 source_revision(커밋 SHA)이 있으면 맨 아래 줄에 앞 7자리를 표시한다.
 * - test(test_result)를 같이 주고 facts.conditions 가 있으면 결론 아래에 조건별 재생 결과 한 줄을 넣는다
 *   ("재생 결과: none 20/20, restart 14/20, replace 13/20"). 결정서만 있으면 이 줄은 없다.
 */
import type { ConditionFact, Plan, PlanRequirement, RollbackPlan, RuleResult, TestResult } from "./schema.js";

export type Lang = "ko" | "ja";
export interface ExplainOptions {
  lang?: Lang;
  /** 결정에 들어간 test_result. facts.conditions 가 있을 때만 조건별 재생 결과 줄을 넣는다 (배포 결정서만) */
  test?: Pick<TestResult, "facts">;
}

const ONPREM = "onprem";
const CLOUD = "cloud_run";
const SHORT = 12;
const SHORT_REVISION = 7;

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
    offNoOnprem: string;
    offBlocked: string;
    offManual: string;
  };
  /** 조건별 재생 결과 한 줄. facts.conditions 가 있을 때만 */
  conditionsLine: (conditions: readonly ConditionFact[]) => string;
  reasonsHeading: string;
  reasonsNone: string;
  defaultPolicy: (reason: string) => string;
  reasonLine: (reason: string, ruleId: string) => string;
  afterBlockHeading: string;
  afterManualHeading: string;
  afterNote: string;
  requiresHeading: string;
  requiresNone: string;
  requiresNote: string;
  requirementLine: (what: string, targets: string, ruleId: string, id: string) => string;
  footer: (planHash: string, digestLabel: string, digest: string) => string;
  revisionLine: (revision: string) => string;
  imageLabel: string;
  serveLabel: string;
  serveNone: string;
}

const STRINGS: Record<Lang, Strings> = {
  ko: {
    targetName: { [ONPREM]: "온프레(사내)", [CLOUD]: "Cloud Run" },
    and: " 및 ",
    none: "없음 (남은 규칙끼리 충돌)",
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
      offNoOnprem: "Cloud Run에만 배포하므로 온프레 장애 시 전환은 해당 없습니다.",
      offBlocked: "배포하지 않으므로 장애 시 전환도 없습니다.",
      offManual: "수동 복구 전까지 장애 시 전환은 없습니다.",
    },
    conditionsLine: (conditions) => `재생 결과: ${conditions.map((c) => `${c.name} ${c.matched}/${c.total}`).join(", ")}`,
    reasonsHeading: "## 이유",
    reasonsNone: "걸린 규칙이 없습니다.",
    defaultPolicy: (reason) => `기본 정책을 적용했습니다: ${reason}`,
    reasonLine: (reason, id) => `- ${reason} (규칙 ${id})`,
    afterBlockHeading: "### 차단이 정해진 뒤에 걸린 규칙",
    afterManualHeading: "### 수동 복구가 정해진 뒤에 걸린 규칙",
    afterNote: "결정은 바꾸지 않았고, 배포 위치와 해결 조건에만 반영됐습니다.",
    requiresHeading: "## 해결 조건",
    requiresNone: "해결할 것이 없습니다.",
    requiresNote: "한 규칙이 해결 조건을 여러 개 요구하면 모두 충족해야 합니다. 수정 후에는 새 버전으로 전체 정책을 다시 평가합니다.",
    requirementLine: (what, t, ruleId, id) => `- **${what}** — 이 위반을 해소하면 나머지 제약상 가능한 배포 위치: ${t} (규칙 ${ruleId}, \`${id}\`)`,
    footer: (hash, label, digest) => `결정 지문 \`${hash}\` · ${label} \`${digest}\``,
    revisionLine: (revision) => `커밋 \`${revision}\``,
    imageLabel: "이미지",
    serveLabel: "트래픽을 받을 버전",
    serveNone: "미정",
  },
  ja: {
    targetName: { [ONPREM]: "オンプレ（社内）", [CLOUD]: "Cloud Run" },
    and: "と",
    none: "なし（残りのルール同士が衝突）",
    deployTitle: (app, runId) => `# デプロイ判定：${app}（実行${runId}）`,
    rollbackTitle: (app, runId) => `# ロールバック判定：${app}（実行${runId}）`,
    conclusion: {
      allow: (t) => `**デプロイ可。**このイメージを${t}にデプロイします。`,
      needs_approval: (t) => `**人の承認が必要。**承認されれば${t}にデプロイします。承認前はデプロイしません。`,
      block: () => `**デプロイ不可。**このイメージはデプロイしません。下記の解決条件を満たしてから再テストが必要です。`,
    },
    rollbackConclusion: {
      keep_stable: (serve, t) => `**正常稼働中のバージョンを維持。**戻すものはありません。正常稼働中のバージョン（${serve}）が引き続き${t}でトラフィックを受けます。`,
      rollback: (serve, t) => `**ロールバック。**正常稼働中のバージョン（${serve}）に戻します。戻す先は${t}です。`,
      manual_recovery: () => `**手動復旧が必要。**自動では戻せません。下記の解決条件に従って人が復旧する必要があり、それまでトラフィックを受けるバージョンは未定です。`,
    },
    failover: {
      on: "オンプレが停止した場合、Cloud Runにトラフィックを切り替えます。",
      offForbidden: "オンプレが停止してもCloud Runには切り替えません（ポリシーで禁止）。",
      offNoCloud: "オンプレが停止してもCloud Runには切り替えません。Cloud Runにはデプロイしないためです。",
      offNoOnprem: "Cloud Runのみにデプロイするため、オンプレ障害時の切り替えは対象外です。",
      offBlocked: "デプロイしないため、障害時の切り替えもありません。",
      offManual: "手動復旧までは障害時の切り替えはありません。",
    },
    conditionsLine: (conditions) => `再生結果：${conditions.map((c) => `${c.name} ${c.matched}/${c.total}`).join("、")}`,
    reasonsHeading: "## 理由",
    reasonsNone: "該当したルールはありません。",
    defaultPolicy: (reason) => `既定ポリシーを適用しました：${reason}`,
    reasonLine: (reason, id) => `- ${reason}（ルール${id}）`,
    afterBlockHeading: "### デプロイ不可が決まった後に該当したルール",
    afterManualHeading: "### 手動復旧が決まった後に該当したルール",
    afterNote: "判定は変えず、デプロイ先と解決条件にのみ反映されました。",
    requiresHeading: "## 解決条件",
    requiresNone: "対応が必要な事項はありません。",
    requiresNote: "1つのルールが複数の解決条件を要求する場合はすべて満たす必要があります。修正後は新しいバージョンでポリシー全体を再評価します。",
    requirementLine: (what, t, ruleId, id) => `- **${what}** — この違反を解消した場合に残りの制約上可能なデプロイ先：${t}（ルール${ruleId}、\`${id}\`）`,
    footer: (hash, label, digest) => `判定ハッシュ\`${hash}\`・${label}\`${digest}\``,
    revisionLine: (revision) => `コミット\`${revision}\``,
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
/** 커밋 SHA 는 앞 7자 */
export const shortRevision = (revision: string): string => revision.slice(0, SHORT_REVISION);

/** 맨 아래 줄: 커밋 앞 7자리. source_revision 이 없으면 아무 줄도 넣지 않는다 */
function revisionLines(revision: string | undefined, s: Strings): string[] {
  return revision !== undefined ? [s.revisionLine(shortRevision(revision))] : [];
}

/** 문장 안에 든 긴 digest 를 앞 12자로 줄인다 (규칙 reason 이 digest 를 통째로 넣었을 때의 안전장치) */
export function shortenDigests(text: string): string {
  return text.replace(/sha256:([0-9a-fA-F]{13,})/g, (_m, hex: string) => `sha256:${hex.slice(0, SHORT)}`);
}

/** lang 에 맞는 문구. 없으면 ko 로 대체 */
function pick(ko: string | undefined, i18n: { ja?: string } | undefined, lang: Lang): string {
  if (lang === "ja" && i18n?.ja !== undefined) return i18n.ja;
  return ko ?? "";
}

function failoverText(decision: string, targets: readonly string[], failoverAllowed: boolean, s: Strings, manual: boolean): string {
  if (decision === "block") return s.failover.offBlocked;
  if (manual) return s.failover.offManual;
  if (failoverAllowed) return s.failover.on;
  const hasOnprem = targets.includes(ONPREM);
  const hasCloud = targets.includes(CLOUD);
  if (hasOnprem && !hasCloud) return s.failover.offNoCloud;
  if (!hasOnprem && hasCloud) return s.failover.offNoOnprem;
  return s.failover.offForbidden;
}

function reasonsSection(rules: readonly RuleResult[], s: Strings, lang: Lang, afterHeading: string): string[] {
  const lines: string[] = [s.reasonsHeading, ""];
  const matched = rules.filter((r) => r.result === "matched");
  const after = rules.filter((r) => r.result === "matched_after_block");
  const text = (r: RuleResult) => shortenDigests(pick(r.reason, r.reason_i18n, lang));

  if (matched.length === 0) {
    lines.push(`- ${s.reasonsNone}`);
  } else {
    for (const r of matched) {
      if (r.id === "default") lines.push(`- ${s.defaultPolicy(text(r))}`);
      else lines.push(s.reasonLine(text(r), r.id));
    }
  }
  if (after.length > 0) {
    lines.push("", afterHeading, "", s.afterNote, "");
    for (const r of after) lines.push(s.reasonLine(text(r), r.id));
  }
  return lines;
}

function requiresSection(requires: readonly PlanRequirement[] | undefined, s: Strings, lang: Lang): string[] {
  const lines: string[] = [s.requiresHeading, ""];
  if (!requires || requires.length === 0) {
    lines.push(`- ${s.requiresNone}`);
    return lines;
  }
  for (const r of requires) {
    const what = shortenDigests(pick(r.hint, r.hint_i18n, lang) || r.id);
    lines.push(s.requirementLine(what, targetsText(r.allowed_targets, s), r.rule_id, r.id));
  }
  lines.push("", s.requiresNote);
  return lines;
}

// ---------------------------------------------------------------------------
// explainPlan / explainRollbackPlan
// ---------------------------------------------------------------------------

/** 조건별 재생 결과 줄. test 가 없거나 facts.conditions 가 비어 있으면 아무 줄도 넣지 않는다 */
function conditionsLines(test: ExplainOptions["test"], s: Strings): string[] {
  const conditions = test?.facts.conditions;
  return conditions !== undefined && conditions.length > 0 ? [s.conditionsLine(conditions), ""] : [];
}

export function explainPlan(plan: Plan, opts: ExplainOptions = {}): string {
  const lang = opts.lang ?? "ko";
  const s = STRINGS[lang];
  const targets = targetsText(plan.targets, s);
  const lines: string[] = [
    s.deployTitle(plan.app, plan.run_id),
    "",
    s.conclusion[plan.decision](targets),
    "",
    failoverText(plan.decision, plan.targets, plan.failover_allowed, s, false),
    "",
    ...conditionsLines(opts.test, s),
    ...reasonsSection(plan.rules, s, lang, s.afterBlockHeading),
    "",
    ...requiresSection(plan.requires, s, lang),
    "",
    "---",
    "",
    s.footer(shortHash(plan.plan_hash), s.imageLabel, shortDigest(plan.digest)),
    ...revisionLines(plan.source_revision, s),
    "",
  ];
  return lines.join("\n");
}

export function explainRollbackPlan(plan: RollbackPlan, opts: ExplainOptions = {}): string {
  const lang = opts.lang ?? "ko";
  const s = STRINGS[lang];
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
    ...reasonsSection(plan.rules, s, lang, s.afterManualHeading),
    "",
    ...requiresSection(plan.requires, s, lang),
    "",
    "---",
    "",
    s.footer(shortHash(plan.plan_hash), s.serveLabel, serve),
    ...revisionLines(plan.source_revision, s),
    "",
  ];
  return lines.join("\n");
}

export const LANGS: readonly Lang[] = ["ko", "ja"];
export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}
