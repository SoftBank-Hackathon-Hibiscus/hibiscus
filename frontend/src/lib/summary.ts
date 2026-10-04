// 결과 요약의 판정. 화면 컴포넌트는 이 결과만 그린다. 문구는 사람이 읽는 말로, 값은 데이터에서.

import type { DeployResult, Plan, PlanRequire, SignResult, TestResult } from '../api/contracts';
import type { DeploymentView, StageExecution, StageName } from '../api/types';
import { findArtifact, latestStages, parseJsonArtifact } from './artifacts';
import { deriveDeployDisplay, type DeployDisplay, type Tone } from './deployState';
import { targetLabel } from './format';
import { pickLang, requireCopy, translate, type DictKey, type Lang } from './i18n';

export interface StepSummary {
  name: StageName;
  label: string;
  /** 한 줄 결과 (이유 포함) */
  result: string;
  tone: Tone;
  duration: string | null;
  stage: StageExecution | undefined;
}

export interface ProofLink {
  id: 'run_id' | 'source' | 'digest' | 'plan_hash';
  title: string;
  /** ok: 모두 같음 / mismatch: 다름 / pending: 비교할 값이 부족 / unverified: 검증 전 / na: 이 실행에서는 해당 없음 */
  state: 'ok' | 'mismatch' | 'pending' | 'unverified' | 'na';
  /** 사람이 읽는 한 문장 */
  detail: string;
  legs: Array<{ label: string; value: string | null }>;
}

export interface RequireView {
  id: string;
  ruleId: string;
  title: string;
  why: string | null;
  /** 고치면 가능한 위치 (allowed_targets 에서 계산) */
  unlocks: string[];
}

export interface DeploymentSummary {
  conclusion: string;
  tone: Tone;
  steps: StepSummary[];
  focusStep: StageName;
  proof: ProofLink[];
  decision: Plan['decision'] | null;
  targets: string[];
  failoverAllowed: boolean | null;
  failoverWhy: string | null;
  /** 2단계: 개발자가 알아야 할 이유 1~3개 */
  reasons: string[];
  requires: RequireView[];
  deploy: DeployDisplay;
  /** 배포 패널에 보여줄 쉬운 문장들 */
  deployLines: string[];
  parsed: {
    test: TestResult | null;
    plan: Plan | null;
    sign: SignResult | null;
    deployResult: DeployResult | null;
  };
}

type Scope = 'blocked' | 'held' | 'deployed' | 'partial';

export function summarizeDeployment(view: DeploymentView, lang: Lang): DeploymentSummary {
  const t = (key: DictKey, params?: Record<string, string | number>) => translate(lang, key, params);
  const d = view.deployment;
  const latest = latestStages(view.stages);
  const testParsed = parseJsonArtifact<TestResult>(findArtifact(view, 'test_result', latest.test));
  const planParsed = parseJsonArtifact<Plan>(findArtifact(view, 'plan', latest.policy));
  const signParsed = parseJsonArtifact<SignResult>(findArtifact(view, 'sign_result', latest.sign));
  const deployParsed = parseJsonArtifact<DeployResult>(findArtifact(view, 'deploy_result', latest.deploy));
  const test = testParsed?.ok ? testParsed.value : null;
  const plan = planParsed?.ok ? planParsed.value : null;
  const sign = signParsed?.ok ? signParsed.value : null;
  const deployResult = deployParsed?.ok ? deployParsed.value : null;

  const pr = view.policyResult;
  const decision = pr?.decision ?? plan?.decision ?? d.decision;
  const targets = pr?.targets ?? plan?.targets ?? [];
  const failoverAllowed = pr?.failoverAllowed ?? plan?.failover_allowed ?? null;
  const rawRequires: PlanRequire[] = plan?.requires ?? ((pr?.requires ?? []) as PlanRequire[]);
  const deploy = deriveDeployDisplay(latest.deploy, deployResult);
  const finished = d.status === 'cancelled' || d.status === 'blocked' || d.status === 'failed' || d.status === 'succeeded';
  const blocked = d.status === 'blocked' || decision === 'block';

  // ---- 진행 범위
  const scope: Scope = blocked
    ? 'blocked'
    : deployResult
      ? deployResult.decision === 'activated' && deployResult.routing.result === 'ok'
        ? 'deployed'
        : 'held'
      : 'partial';

  // ---- 테스트 사실
  const conditions = test?.facts?.conditions ?? [];
  const failedConditions = conditions.filter((c) => c.failed);
  const conditionName = (name: string) => (name === 'none' ? t('conditionNone') : name === 'restart' ? t('conditionRestart') : name === 'replace' ? t('conditionReplace') : name);
  const testPassed = test ? test.passed : typeof (latest.test?.summary as { test_passed?: unknown } | null)?.test_passed === 'boolean' ? ((latest.test!.summary as { test_passed: boolean }).test_passed) : null;

  // ---- 2단계 이유
  const reasons: string[] = [];
  for (const c of failedConditions) reasons.push(t('conditionFailLine', { name: conditionName(c.name), total: c.total, diff: c.total - c.matched }));
  if (test && !conditions.length && !test.passed) reasons.push(`${test.match.matched}/${test.match.total} ${t('requestsMatched')}`);
  if (test?.facts?.db === 'sqlite') reasons.push(t('factSqlite'));
  else if (test?.facts?.db && test.facts.db !== 'none' && decision !== 'block') reasons.push(t('factDb', { db: test.facts.db }));
  const localFiles = (test?.facts?.writes_local_file ?? []).filter((p) => !/\.(db|sqlite3?)$/.test(p));
  if (localFiles.length) reasons.push(t('factLocalFiles', { paths: localFiles.join(', ') }));
  if (test?.facts?.migration?.destructive) reasons.push(t('factMigrationDestructive'));
  if (reasons.length === 0 && plan) {
    for (const r of plan.rules.filter((x) => x.result === 'matched')) {
      const reason = pickLang(lang, r.reason, r.reason_i18n);
      if (reason) reasons.push(reason);
    }
  }

  // ---- 고칠 것
  const requires: RequireView[] = rawRequires.map((r) => {
    const copy = translateRequire(lang, r);
    return { id: r.id, ruleId: r.rule_id, title: copy.title, why: copy.why, unlocks: r.allowed_targets ?? [] };
  });

  // ---- failover 이유
  let failoverWhy: string | null = null;
  if (failoverAllowed === false) {
    if (blocked) failoverWhy = t('failoverWhyBlocked');
    else if (targets.length < 2) failoverWhy = t('failoverWhyOneTarget');
    else failoverWhy = t('failoverWhyPolicy');
  }

  // ---- 단계 띠
  const notRunReason = d.status === 'cancelled' ? t('statusCancelled') : blocked ? t('notRunBlocked') : d.status === 'failed' ? t('notRunEarlier') : null;
  const stepFor = (name: StageName, label: string, stage: StageExecution | undefined, word: [string, Tone] | null): StepSummary => {
    const base = { name, label, stage, duration: stage ? formatDuration(lang, stage.startedAt, stage.finishedAt) : null };
    const status = stage?.status;
    if (word && status !== 'pending' && status !== 'running') return { ...base, result: word[0], tone: word[1] };
    if (status === 'running') return { ...base, result: t('resultRunning'), tone: 'info' };
    if (status === 'failed') return { ...base, result: stage?.error && name === 'deploy' ? t('notRunGate') : t('resultError'), tone: 'danger' };
    if (status === 'skipped') return { ...base, result: t('resultSkipped'), tone: 'muted' };
    if (status === 'succeeded') return { ...base, result: t('statusSucceeded'), tone: 'success' };
    if (!stage && finished) return { ...base, result: notRunReason ?? t('resultPending'), tone: 'muted' };
    return { ...base, result: t('resultPending'), tone: 'muted' };
  };

  const deployWord = (): [string, Tone] | null => {
    if (!deployResult) return null;
    switch (deployResult.decision) {
      case 'activated':
        return deployResult.routing.result === 'ok' ? [t('resultDeployed'), 'success'] : [t('resultSwitchFailed'), 'danger'];
      case 'held':
        return [t('resultHeld'), 'warning'];
      case 'rolled_back':
        return [t('resultRolledBack'), 'warning'];
      case 'error':
        return [t('resultError'), 'danger'];
    }
  };

  const testWord: [string, Tone] | null = testPassed === null ? null : testPassed ? [t('resultTestPassed'), 'success'] : [failedConditions.length ? t('resultTestFailed') : t('resultTestFailedGeneric'), 'danger'];
  const steps: StepSummary[] = [
    stepFor('test', t('stepTest'), latest.test, testWord),
    stepFor('policy', t('stepPolicy'), latest.policy, decision === 'allow' ? [t('resultAllow'), 'success'] : decision === 'block' ? [t('resultBlock'), 'danger'] : decision === 'needs_approval' ? [d.approver ? t('resultApproved') : t('resultNeedsApproval'), 'warning'] : null),
    stepFor('sign', t('stepSign'), latest.sign, sign ? (sign.signature_ref.startsWith('dry-run:') ? [t('resultDryRun'), 'muted'] : [t('resultSigned'), 'success']) : null),
    stepFor('deploy', t('stepDeploy'), latest.deploy, deployWord()),
  ];

  // ---- 결론
  const [conclusion, tone, focusStep] = conclude(view, decision, deployResult, lang, targets, failedConditions.length > 0, requires);

  // ---- 배포 패널 문장
  const deployLines = describeDeploy(lang, latest.deploy, deployResult, deploy);

  // ---- 증명 체인
  const proof = buildProof(view, { test, plan, sign, deployResult, scope, lang, policyHash: pr?.planHash ?? plan?.plan_hash ?? null });

  return { conclusion, tone, steps, focusStep, proof, decision, targets, failoverAllowed, failoverWhy, reasons, requires, deploy, deployLines, parsed: { test, plan, sign, deployResult } };
}

function formatDuration(lang: Lang, start: string, end: string | null): string | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (lang === 'ja') return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`;
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

function translateRequire(lang: Lang, r: PlanRequire): { title: string; why: string | null } {
  const copy = requireCopy(lang, r.id);
  if (copy) return copy;
  const hint = pickLang(lang, r.hint, r.hint_i18n);
  return { title: hint ?? r.id, why: null };
}

function conclude(view: DeploymentView, decision: Plan['decision'] | null, result: DeployResult | null, lang: Lang, targets: string[], restartIssue: boolean, requires: RequireView[]): [string, Tone, StageName] {
  const ja = lang === 'ja';
  const d = view.deployment;
  const name = (kind: string | undefined) => targetLabel(kind);
  if (d.status === 'queued') return [ja ? 'まもなく検証を始めます。' : '잠시 뒤 검증을 시작합니다.', 'info', 'test'];
  if (d.status === 'running') return [ja ? '検証を進めています。' : '검증을 진행하고 있습니다.', 'info', d.currentStage ?? 'test'];
  if (d.status === 'cancelled') return [ja ? 'デプロイをキャンセルしました。次のステップは開始しません。' : '배포를 취소했습니다. 다음 단계는 시작하지 않습니다.', 'muted', d.currentStage ?? 'test'];
  if (d.status === 'awaiting_approval') return [ja ? '人が承認するとデプロイできます。' : '사람이 승인해야 배포할 수 있습니다.', 'warning', 'policy'];
  if (d.status === 'blocked' || decision === 'block') {
    const ids = requires.map((r) => r.id);
    if (restartIssue || ids.includes('fix_restart_failure')) return [ja ? '再起動するとデータが消えるため、デプロイを止めました。' : '재시작하면 데이터가 사라져 배포를 막았습니다.', 'danger', 'policy'];
    if (ids.includes('fix_tests')) return [ja ? 'テストで期待どおりの応答が得られず、デプロイを止めました。' : '테스트에서 기대한 응답이 나오지 않아 배포를 막았습니다.', 'danger', 'policy'];
    if (ids.includes('two_phase_migration')) return [ja ? '元に戻せないデータベース変更があるため、デプロイを止めました。' : '되돌릴 수 없는 데이터베이스 변경이 있어 배포를 막았습니다.', 'danger', 'policy'];
    if (ids.includes('rerun_same_run')) return [ja ? 'テストと個人情報判定の実行が一致せず、デプロイを止めました。' : '테스트와 개인정보 판정의 실행이 맞지 않아 배포를 막았습니다.', 'danger', 'policy'];
    return [ja ? 'ポリシーが許可しないため、デプロイを止めました。' : '정책이 허용하지 않아 배포를 막았습니다.', 'danger', 'policy'];
  }
  if (result) {
    const r = result.routing;
    switch (result.decision) {
      case 'activated':
        if (r.result === 'ok') {
          const standbyKind = r.standby_target_id ? (r.kind === 'onprem' ? 'cloud_run' : 'onprem') : null;
          return [
            ja
              ? `イメージを ${name(r.kind)} にデプロイしました。${standbyKind ? `${name(standbyKind)} は待機中です。` : ''}`
              : `이미지를 ${name(r.kind)}에 배포했습니다.${standbyKind ? ` ${name(standbyKind)}은 대기 중입니다.` : ''}`,
            'success',
            'policy',
          ];
        }
        if (r.result === 'error') return [ja ? '新バージョンは起動しましたが、トラフィック切替に失敗しました。' : '새 버전은 떴지만 트래픽 전환에 실패했습니다.', 'danger', 'deploy'];
        return [ja ? '新バージョンを有効化しましたが、トラフィックはまだ切り替えていません。' : '새 버전을 활성화했지만 트래픽은 아직 옮기지 않았습니다.', 'warning', 'deploy'];
      case 'held':
        return [ja ? '新バージョンが検査を通らず、トラフィックを切り替えませんでした。既存サービスはそのままです。' : '새 버전이 검사를 통과하지 못해 트래픽을 옮기지 않았습니다. 기존 서비스는 그대로입니다.', 'warning', 'deploy'];
      case 'rolled_back':
        return [ja ? '切替中に問題が起きたため、前のバージョンに戻しました。' : '전환 중 문제가 생겨 이전 버전으로 되돌렸습니다.', 'warning', 'deploy'];
      case 'error':
        return [ja ? 'デプロイ中にエラーが起きて止まりました。' : '배포 중 오류가 나서 멈췄습니다.', 'danger', 'deploy'];
    }
  }
  if (d.status === 'failed') return [ja ? 'デプロイを完了できませんでした。' : '배포를 끝내지 못했습니다.', 'danger', 'deploy'];
  if (d.status === 'succeeded') {
    const where = targets.map(name).join(ja ? '・' : ', ');
    return [ja ? `検証は完了しました。この実行ではデプロイ段階を省略しました（許可先 ${where}）。` : `검증은 끝났습니다. 이번 실행에서는 배포 단계를 생략했습니다 (허용 위치 ${where}).`, 'success', 'policy'];
  }
  return [ja ? '状態を判定できません。' : '상태를 판정할 수 없습니다.', 'muted', 'policy'];
}

function describeDeploy(lang: Lang, stage: StageExecution | undefined, result: DeployResult | null, display: DeployDisplay): string[] {
  const t = (key: DictKey, params?: Record<string, string | number>) => translate(lang, key, params);
  const lines: string[] = [];
  if (!stage) {
    lines.push(t('deployLineNotRun'));
    return lines;
  }
  if (stage.status === 'skipped') {
    lines.push(t('deployLineSkipped'));
    return lines;
  }
  if (!result) {
    if (stage.status === 'failed') lines.push(t('deployLineGate', { reason: stage.error ?? display.title }));
    else lines.push(t('deployLineNotRun'));
    return lines;
  }
  const r = result.routing;
  const other = (kind: string | undefined) => (kind === 'onprem' ? 'cloud_run' : 'onprem');
  switch (result.decision) {
    case 'activated':
      if (r.result === 'ok') {
        lines.push(t('deployLineActivated', { target: targetLabel(r.kind) }));
        if (r.standby_target_id) lines.push(t(r.standby_enabled ? 'deployLineStandby' : 'deployLineStandbyOff', { target: targetLabel(other(r.kind)) }));
      } else if (r.result === 'error') {
        lines.push(t('deployLineSwitchFailed'));
      } else {
        lines.push(t('deployLineActivated', { target: targetLabel(result.targets.find((s) => s.phase === 'activate' && s.result === 'ok')?.target) }));
      }
      break;
    case 'held': {
      lines.push(t('deployLineHeld'));
      for (const c of result.checks) lines.push(c.pass ? t('checkPassed', { target: targetLabel(c.target) }) : t('checkFailed', { target: targetLabel(c.target) }));
      for (const s of result.targets.filter((x) => x.phase === 'candidate' && x.result === 'error')) lines.push(t('candidateFailed', { target: targetLabel(s.target) }));
      if (result.targets.some((x) => x.phase === 'discard' && x.result === 'ok')) lines.push(t('deployLineDiscarded'));
      break;
    }
    case 'rolled_back': {
      // main 2cca2c3: 대표 경로 변경 실패도 전환한 대상을 모두 되돌린 뒤 rolled_back 으로 기록한다
      lines.push(r.result === 'error' ? t('deployLineRouteFailRolledBack') : t('deployLineRolledBack'));
      for (const s of result.targets.filter((x) => x.phase === 'rollback' && x.result === 'ok')) {
        lines.push(s.serving ? t('rollbackOkServing', { target: targetLabel(s.target), serving: s.serving }) : t('rollbackOk', { target: targetLabel(s.target) }));
      }
      break;
    }
    case 'error': {
      lines.push(r.result === 'error' ? t('deployLineRouteFailError') : t('deployLineError'));
      const rollbackFailedTargets = result.targets.filter((x) => x.phase === 'rollback' && x.result === 'error');
      for (const s of rollbackFailedTargets) lines.push(t('rollbackFailed', { target: targetLabel(s.target) }));
      const cloudActivated = result.targets.some((x) => x.target === 'cloud_run' && x.phase === 'activate' && x.result === 'ok');
      const cloudRestored = result.targets.some((x) => x.target === 'cloud_run' && x.phase === 'rollback' && x.result === 'ok');
      if (cloudActivated && !cloudRestored) lines.push(t('deployLineErrorCloud'));
      break;
    }
  }
  return lines;
}

interface ProofInput {
  test: TestResult | null;
  plan: Plan | null;
  sign: SignResult | null;
  deployResult: DeployResult | null;
  scope: Scope;
  lang: Lang;
  policyHash: string | null;
}

function buildProof(view: DeploymentView, input: ProofInput): ProofLink[] {
  const { test, plan, sign, deployResult, scope, lang, policyHash } = input;
  const ja = lang === 'ja';
  const t = (key: DictKey) => translate(lang, key);
  const d = view.deployment;

  const pick = (ko: string, jaText: string) => (ja ? jaText : ko);
  const same = (values: Array<string | null>) => {
    const present = values.filter((v): v is string => Boolean(v));
    if (present.length < 2) return 'pending' as const;
    return present.every((v) => v === present[0]) ? ('ok' as const) : ('mismatch' as const);
  };
  const mismatchText = pick('값이 서로 달라요. 세부 기술 정보를 확인하세요.', '値が一致しません。技術的な詳細を確認してください。');
  const pendingText = (why: string) => pick(`아직 확인할 수 없어요: ${why}`, `まだ確認できません: ${why}`);

  // 같은 배포 요청 (run_id)
  const runLegs = [
    { label: t('deployment'), value: d.id },
    { label: t('stepTest'), value: test?.run_id ?? null },
    { label: t('stepPolicy'), value: plan?.run_id ?? null },
    { label: t('stepSign'), value: sign?.run_id ?? null },
    { label: t('deployDetail'), value: deployResult?.run_id ?? null },
  ];
  const runState = same(runLegs.map((l) => l.value));
  const runDetail =
    runState === 'mismatch'
      ? mismatchText
      : runState === 'pending'
        ? pendingText(pick('테스트나 정책 결과가 아직 없어요', 'テストまたはポリシー結果がまだありません'))
        : scope === 'blocked'
          ? pick('테스트와 정책 판단이 하나의 실행으로 이어졌어요.', 'テストとポリシー判定が1つの実行としてつながっています。')
          : deployResult
            ? pick('테스트부터 배포까지 하나의 실행으로 이어졌어요.', 'テストからデプロイまで1つの実行としてつながっています。')
            : pick('테스트부터 서명까지 하나의 실행으로 이어졌어요.', 'テストから署名まで1つの実行としてつながっています。');

  // 같은 코드 (source ↔ image)
  // 최신 main(#33·#29)에서는 verified 가 registry parity 성공으로만 true 가 되고, 그 경우 테스트 summary 는 stub=false 다.
  // 아래 분기는 #33·#29 이전에 만들어진 기존 행(verified=true + stub 테스트)을 위한 방어다. 새 배포는 이 분기에 오지 않는다.
  // stub 테스트는 커밋↔이미지 연결을 실제로 확인한 것이 아니므로 "확인 전"으로 둔다.
  const testStub = (latestStages(view.stages).test?.summary as { stub?: unknown } | null)?.stub === true;
  const sourceState: ProofLink['state'] = d.sourceRevisionVerified ? (testStub ? 'pending' : 'ok') : 'unverified';
  const sourceLink: ProofLink = {
    id: 'source',
    title: t('proofSource'),
    state: sourceState,
    detail:
      sourceState === 'ok'
        ? pick('이 커밋에서 만든 이미지인지 확인했어요.', 'このコミットから作ったイメージであることを確認しました。')
        : sourceState === 'pending'
          ? pick('이 실행은 실제 재생 테스트를 하지 않아 커밋과 이미지의 연결은 아직 확인할 수 없어요.', 'この実行は実際の再生テストを行っていないため、コミットとイメージのつながりはまだ確認できません。')
          : pick('커밋과 이미지의 연결은 아직 확인하지 않았어요. 빌드 검증을 거치면 확인돼요.', 'コミットとイメージのつながりはまだ確認していません。ビルド検証を経ると確認されます。'),
    legs: [
      { label: t('commit'), value: d.sourceRevision },
      { label: t('digest'), value: d.imageDigest },
    ],
  };

  // 같은 이미지 (digest)
  const digestLegs = [
    { label: t('deployment'), value: d.imageDigest },
    { label: t('stepTest'), value: test?.digest ?? null },
    { label: t('stepPolicy'), value: plan?.digest ?? null },
    { label: t('stepSign'), value: sign?.digest ?? null },
    { label: t('deployDetail'), value: deployResult?.digest ?? null },
  ];
  const digestState = same(digestLegs.map((l) => l.value));
  const digestDetail =
    digestState === 'mismatch'
      ? mismatchText
      : digestState === 'pending'
        ? pendingText(pick('테스트나 정책 결과가 아직 없어요', 'テストまたはポリシー結果がまだありません'))
        : scope === 'blocked'
          ? pick('테스트와 정책 판단이 같은 이미지를 기준으로 했어요.', 'テストとポリシー判定が同じイメージを基準にしました。')
          : scope === 'deployed'
            ? pick('테스트한 이미지 그대로 서명하고 배포했어요.', 'テストしたイメージをそのまま署名してデプロイしました。')
            : sign
              ? pick('서명까지 같은 이미지를 기준으로 했어요.', '署名まで同じイメージを基準にしました。')
              : pick('테스트와 정책 판단이 같은 이미지를 기준으로 했어요.', 'テストとポリシー判定が同じイメージを基準にしました。');

  // 같은 결정 (plan_hash)
  let planState: ProofLink['state'];
  let planDetail: string;
  if (scope === 'blocked') {
    planState = 'na';
    planDetail = pick('정책에서 차단되어 서명과 배포로 진행하지 않았어요.', 'ポリシーで止まったため署名とデプロイには進みませんでした。');
  } else if (!policyHash || !sign) {
    planState = 'pending';
    planDetail = pendingText(pick('서명 결과가 아직 없어요', '署名結果がまだありません'));
  } else if (policyHash !== sign.plan_hash) {
    planState = 'mismatch';
    planDetail = mismatchText;
  } else if (scope === 'deployed') {
    planState = 'ok';
    planDetail = pick('정책이 허용한 위치와 장애 전환 설정 그대로 배포했어요.', 'ポリシーが許可した場所と障害切替の設定どおりにデプロイしました。');
  } else if (scope === 'held') {
    planState = 'ok';
    planDetail = pick('정책 결정 그대로 서명했지만, 새 버전이 검사를 통과하지 못해 트래픽을 옮기지 않았어요.', 'ポリシー判定どおりに署名しましたが、新バージョンが検査を通らずトラフィックは切り替えませんでした。');
  } else {
    planState = 'ok';
    planDetail = pick('정책 결정 그대로 서명했어요.', 'ポリシー判定どおりに署名しました。');
  }

  return [
    { id: 'run_id', title: t('proofRun'), state: runState, detail: runDetail, legs: runLegs },
    sourceLink,
    { id: 'digest', title: t('proofDigest'), state: digestState, detail: digestDetail, legs: digestLegs },
    {
      id: 'plan_hash',
      title: t('proofPlan'),
      state: planState,
      detail: planDetail,
      legs: [
        { label: t('stepPolicy'), value: policyHash },
        { label: t('stepSign'), value: sign?.plan_hash ?? null },
        { label: t('deployDetail'), value: deployResult ? (deployResult.signature ? pick('서명 검증됨', '署名検証済み') : null) : null },
      ],
    },
  ];
}
