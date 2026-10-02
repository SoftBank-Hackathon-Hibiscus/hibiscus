// 결과 요약의 판정. 화면 컴포넌트는 이 결과만 그린다.

import type { DeployResult, Plan, PlanRequire, SignResult, TestResult } from '../api/contracts';
import type { DeploymentView, StageExecution, StageName } from '../api/types';
import { findArtifact, latestStages, parseJsonArtifact } from './artifacts';
import { deriveDeployDisplay, type DeployDisplay, type Tone } from './deployState';
import { durationBetween } from './format';
import { pickLang, translate, type Lang } from './i18n';

export interface StepSummary {
  name: StageName;
  label: string;
  /** 한 단어 결과 */
  result: string;
  tone: Tone;
  duration: string | null;
  stage: StageExecution | undefined;
}

export interface ProofLink {
  id: 'run_id' | 'source' | 'digest' | 'plan_hash';
  title: string;
  /** ok: 모두 같음 / mismatch: 다름 / pending: 비교할 값이 부족 / unverified: 검증 전 */
  state: 'ok' | 'mismatch' | 'pending' | 'unverified';
  detail: string;
  legs: Array<{ label: string; value: string | null }>;
}

export interface DeploymentSummary {
  conclusion: string;
  tone: Tone;
  steps: StepSummary[];
  /** 결론과 가장 관련된 단계 */
  focusStep: StageName;
  proof: ProofLink[];
  decision: Plan['decision'] | null;
  targets: string[];
  failoverAllowed: boolean | null;
  requires: PlanRequire[];
  deploy: DeployDisplay;
  parsed: {
    test: TestResult | null;
    plan: Plan | null;
    sign: SignResult | null;
    deployResult: DeployResult | null;
  };
}

export function summarizeDeployment(view: DeploymentView, lang: Lang): DeploymentSummary {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);
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
  const requires: PlanRequire[] = plan?.requires ?? ((pr?.requires ?? []) as PlanRequire[]);
  const deploy = deriveDeployDisplay(latest.deploy, deployResult);
  const finished = d.status === 'blocked' || d.status === 'failed' || d.status === 'succeeded';

  const testSummary = (latest.test?.summary ?? {}) as { test_passed?: unknown };
  const testPassed = test ? test.passed : typeof testSummary.test_passed === 'boolean' ? testSummary.test_passed : null;

  const stepFor = (name: StageName, label: string, stage: StageExecution | undefined, word: [string, Tone] | null): StepSummary => {
    const duration = stage ? durationBetween(stage.startedAt, stage.finishedAt) : null;
    const base = { name, label, stage, duration: duration === '—' ? null : duration };
    const status = stage?.status;
    if (word && status !== 'pending' && status !== 'running') return { ...base, result: word[0], tone: word[1] };
    if (status === 'running') return { ...base, result: t('running'), tone: 'info' };
    if (status === 'failed') return { ...base, result: t('failed'), tone: 'danger' };
    if (status === 'skipped') return { ...base, result: t('skipped'), tone: 'muted' };
    if (status === 'succeeded') return { ...base, result: t('done'), tone: 'success' };
    if (!stage && finished) return { ...base, result: t('notRun'), tone: 'muted' };
    return { ...base, result: t('pending'), tone: 'muted' };
  };

  const deployWord = (): [string, Tone] | null => {
    if (!deployResult) {
      if (deploy.tone === 'muted') return null;
      return [deploy.tone === 'danger' ? t('notStarted') : t('pending'), deploy.tone];
    }
    switch (deployResult.decision) {
      case 'activated':
        return deployResult.routing.result === 'ok' ? [t('done'), 'success'] : [t('switchFailed'), 'danger'];
      case 'held':
        return [t('held'), 'warning'];
      case 'rolled_back':
        return [t('rolledBack'), 'warning'];
      case 'error':
        return [t('error'), 'danger'];
    }
  };

  const steps: StepSummary[] = [
    stepFor('test', t('stepTest'), latest.test, testPassed === null ? null : testPassed ? [t('passed'), 'success'] : [t('failed'), 'danger']),
    stepFor(
      'policy',
      t('stepPolicy'),
      latest.policy,
      decision === 'allow' ? [t('allow'), 'success'] : decision === 'block' ? [t('blocked'), 'danger'] : decision === 'needs_approval' ? [d.approver ? t('approved') : t('approvalNeeded'), 'warning'] : null,
    ),
    stepFor('sign', t('stepSign'), latest.sign, sign ? (sign.signature_ref.startsWith('dry-run:') ? [t('dryRun'), 'muted'] : [t('signed'), 'success']) : null),
    stepFor('deploy', t('stepDeploy'), latest.deploy, deployWord()),
  ];

  const [conclusion, tone, focusStep] = conclude(view, decision, plan, deployResult, lang, targets);

  const proof: ProofLink[] = [
    compareLink('run_id', t('proofRun'), lang, [
      [t('deployment'), d.id],
      [t('stepTest'), test?.run_id ?? null],
      [t('stepPolicy'), plan?.run_id ?? null],
      [t('stepSign'), sign?.run_id ?? null],
      [t('deployDetail'), deployResult?.run_id ?? null],
    ]),
    {
      id: 'source',
      title: t('proofSource'),
      state: d.sourceRevisionVerified ? 'ok' : 'unverified',
      detail: d.sourceRevisionVerified
        ? lang === 'ja'
          ? 'registry parity がビルド manifest とテスト結果のコミット・digest を照合済み'
          : 'registry parity가 빌드 manifest와 테스트 결과의 커밋·digest를 교차 확인함'
        : lang === 'ja'
          ? 'registry parity 検証前。手動・webhook デプロイはこの状態から始まる'
          : 'registry parity 검증 전. 수동·webhook 배포는 모두 이 상태로 시작함',
      legs: [
        { label: t('commit'), value: d.sourceRevision },
        { label: 'digest', value: d.imageDigest },
      ],
    },
    compareLink('digest', t('proofDigest'), lang, [
      [t('deployment'), d.imageDigest],
      [t('stepTest'), test?.digest ?? null],
      [t('stepPolicy'), plan?.digest ?? null],
      [t('stepSign'), sign?.digest ?? null],
      [t('deployDetail'), deployResult?.digest ?? null],
    ]),
    planHashLink(pr?.planHash ?? plan?.plan_hash ?? null, sign, deployResult, lang),
  ];

  return { conclusion, tone, steps, focusStep, proof, decision, targets, failoverAllowed, requires, deploy, parsed: { test, plan, sign, deployResult } };
}

function conclude(view: DeploymentView, decision: Plan['decision'] | null, plan: Plan | null, result: DeployResult | null, lang: Lang, targets: string[]): [string, Tone, StageName] {
  const ja = lang === 'ja';
  const d = view.deployment;
  const name = (kind: string | undefined) => translate(lang, kind === 'onprem' ? 'onprem' : 'cloud_run');
  if (d.status === 'queued') return [ja ? '待機中: パイプラインがまもなく始まります' : '대기 중: 파이프라인이 곧 시작됩니다', 'info', 'test'];
  if (d.status === 'running') return [ja ? '実行中' : '진행 중', 'info', d.currentStage ?? 'test'];
  if (d.status === 'awaiting_approval') return [ja ? '承認待ち: 人が確認するとデプロイできます' : '승인 대기: 사람이 확인해야 배포할 수 있습니다', 'warning', 'policy'];
  if (d.status === 'blocked' || decision === 'block') {
    const ids = (plan?.requires ?? []).map((r) => r.id);
    if (ids.includes('fix_restart_failure') || ids.includes('fix_tests') || ids.includes('investigate_replace_failure')) {
      return [ja ? 'ブロック: 再起動・入れ替え後にデータが消えます' : '차단됨: 재시작·교체 후 데이터가 사라집니다', 'danger', 'policy'];
    }
    const rule = plan?.rules.find((r) => r.result === 'matched');
    const reason = rule ? pickLang(lang, rule.reason, rule.reason_i18n) : undefined;
    return [reason ? `${ja ? 'ブロック' : '차단됨'}: ${reason}` : ja ? 'ブロック: ポリシーがデプロイを許可しません' : '차단됨: 정책이 배포를 허용하지 않습니다', 'danger', 'policy'];
  }
  if (result) {
    const r = result.routing;
    switch (result.decision) {
      case 'activated':
        if (r.result === 'ok') {
          const standby = r.standby_target_id ? name(r.kind === 'onprem' ? 'cloud_run' : 'onprem') : null;
          return [
            ja
              ? `検証済みイメージがポリシーを通過し ${name(r.kind)} にデプロイされました${standby ? `。${standby} は待機` : ''}`
              : `검증된 이미지가 정책을 통과해 ${name(r.kind)}에 배포되었습니다${standby ? `. ${standby} 대기` : ''}`,
            'success',
            'policy',
          ];
        }
        if (r.result === 'error') return [ja ? '注意: 新バージョンは起動しましたがトラフィック切替に失敗しました' : '주의: 새 버전은 떴지만 트래픽 전환에 실패했습니다', 'danger', 'deploy'];
        return [ja ? '有効化済み: トラフィックはまだ切り替えていません' : '활성화됨: 트래픽은 아직 바꾸지 않았습니다', 'warning', 'deploy'];
      case 'held':
        return [ja ? '安全に保留: 新バージョンの検査に失敗し、既存サービスは継続中' : '안전하게 보류됨: 새 버전 검사 실패, 기존 서비스 계속 동작 중', 'warning', 'deploy'];
      case 'rolled_back':
        return [ja ? '前バージョンへ復旧: 切替中の失敗を戻しました' : '이전 버전으로 복구됨: 전환 중 실패를 되돌렸습니다', 'warning', 'deploy'];
      case 'error':
        return [`${ja ? 'デプロイエラー' : '배포 오류'}: ${result.error ?? (ja ? '原因未記録' : '원인 미기록')}`, 'danger', 'deploy'];
    }
  }
  if (d.status === 'failed') return [`${ja ? '失敗' : '실패'}: ${d.error ?? ''}`, 'danger', 'deploy'];
  if (d.status === 'succeeded') {
    const where = targets.map(name).join(ja ? '・' : ', ');
    return [ja ? `検証完了: デプロイ段階はスキップされ、実際のデプロイはありません（許可先 ${where}）` : `검증 완료: 배포 단계는 생략되어 실제 배포는 없습니다 (허용 위치 ${where})`, 'success', 'policy'];
  }
  return [ja ? '状態を判定できません' : '상태를 판정할 수 없습니다', 'muted', 'policy'];
}

function compareLink(id: ProofLink['id'], title: string, lang: Lang, pairs: Array<[string, string | null]>): ProofLink {
  const ja = lang === 'ja';
  const legs = pairs.map(([label, value]) => ({ label, value }));
  const values = legs.map((l) => l.value).filter((v): v is string => Boolean(v));
  if (values.length < 2) return { id, title, state: 'pending', detail: ja ? '比較できる値が2つ未満' : '비교할 값이 아직 2개 미만', legs };
  const first = values[0]!;
  const same = values.every((v) => v === first);
  return {
    id,
    title,
    state: same ? 'ok' : 'mismatch',
    detail: same ? (ja ? `${values.length} 段階の値が一致` : `${values.length}개 단계의 값이 같음`) : ja ? '段階間で値が異なる。成果物を確認する必要あり' : '단계 사이 값이 다름. 산출물을 확인해야 함',
    legs,
  };
}

function planHashLink(policyHash: string | null, sign: SignResult | null, result: DeployResult | null, lang: Lang): ProofLink {
  const ja = lang === 'ja';
  const title = translate(lang, 'proofPlan');
  const legs = [
    { label: translate(lang, 'stepPolicy'), value: policyHash },
    { label: translate(lang, 'stepSign'), value: sign?.plan_hash ?? null },
    { label: translate(lang, 'deployDetail'), value: result ? (result.signature ? (ja ? '署名検証済み' : '서명 검증됨') : null) : null },
  ];
  if (!policyHash || !sign) return { id: 'plan_hash', title, state: 'pending', detail: ja ? 'ポリシーまたは署名結果がまだない' : '정책 또는 서명 결과가 아직 없음', legs };
  if (policyHash !== sign.plan_hash) return { id: 'plan_hash', title, state: 'mismatch', detail: ja ? 'ポリシーと署名の plan_hash が異なる' : '정책과 서명의 plan_hash가 다름', legs };
  const deployNote = result
    ? result.signature
      ? ja
        ? '。デプロイは cosign 署名検証で間接確認（deploy_result に plan_hash はない）'
        : '. 배포는 cosign 서명 검증으로 간접 확인 (deploy_result에는 plan_hash가 없음)'
      : ja
        ? '。デプロイ結果に署名検証の記録がない'
        : '. 배포 결과에 서명 검증 기록이 없음'
    : '';
  return { id: 'plan_hash', title, state: 'ok', detail: `${ja ? 'ポリシーと署名の plan_hash が一致' : '정책과 서명의 plan_hash가 같음'}${deployNote}`, legs };
}
