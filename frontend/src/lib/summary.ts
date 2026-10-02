// 결과 요약 카드의 판정. 화면 컴포넌트는 이 결과만 그린다.

import type { DeployResult, Plan, PlanRequire, SignResult, TestResult } from '../api/contracts';
import type { DeploymentView, StageName } from '../api/types';
import { findArtifact, latestStages, parseJsonArtifact } from './artifacts';
import { deriveDeployDisplay, type DeployDisplay, type Tone } from './deployState';
import { targetLabel } from './format';

export interface StepSummary {
  name: StageName;
  label: string;
  /** 한 단어 결과 */
  result: string;
  tone: Tone;
}

export interface ProofLink {
  id: 'run_id' | 'source' | 'digest' | 'plan_hash';
  title: string;
  /** ok: 모두 같음 / mismatch: 다름 / pending: 비교할 값이 부족 / unverified: 검증 전 */
  state: 'ok' | 'mismatch' | 'pending' | 'unverified';
  detail: string;
  /** 어느 단계의 값을 비교했는지 */
  legs: Array<{ label: string; value: string | null }>;
}

export interface DeploymentSummary {
  conclusion: string;
  tone: Tone;
  steps: StepSummary[];
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

export function summarizeDeployment(view: DeploymentView): DeploymentSummary {
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

  // ---- 단계 띠
  const testStage = latest.test;
  const testSummary = (testStage?.summary ?? {}) as { test_passed?: unknown };
  const testPassed = test ? test.passed : typeof testSummary.test_passed === 'boolean' ? testSummary.test_passed : null;
  const steps: StepSummary[] = [
    stepFor('test', '테스트', testStage?.status, testPassed === null ? null : testPassed ? ['통과', 'success'] : ['실패', 'danger']),
    stepFor(
      'policy',
      '정책',
      latest.policy?.status,
      decision === 'allow' ? ['허용', 'success'] : decision === 'block' ? ['차단', 'danger'] : decision === 'needs_approval' ? [d.approver ? '승인됨' : '승인 필요', 'warning'] : null,
    ),
    stepFor('sign', '서명', latest.sign?.status, sign ? (sign.signature_ref.startsWith('dry-run:') ? ['모의 서명', 'muted'] : ['서명됨', 'success']) : null),
    stepFor('deploy', '배포', latest.deploy?.status, deployWord(deploy, deployResult)),
  ];

  // ---- 결론
  const [conclusion, tone] = conclude(view, decision, plan, deploy, deployResult, steps);

  // ---- 증명 체인
  const proof: ProofLink[] = [
    compareLink('run_id', '실행 ID가 모든 단계에서 같음', [
      ['배포', d.id],
      ['테스트', test?.run_id ?? null],
      ['정책', plan?.run_id ?? null],
      ['서명', sign?.run_id ?? null],
      ['배포 결과', deployResult?.run_id ?? null],
    ]),
    {
      id: 'source',
      title: '소스 커밋과 테스트한 이미지가 연결됨',
      state: d.sourceRevisionVerified ? 'ok' : 'unverified',
      detail: d.sourceRevisionVerified
        ? 'registry parity가 빌드 manifest와 테스트 결과의 커밋·digest를 교차 확인함'
        : 'registry parity 검증 전. 수동·webhook 배포는 모두 이 상태로 시작함',
      legs: [
        ['커밋', d.sourceRevision],
        ['digest', d.imageDigest],
      ].map(([label, value]) => ({ label: label!, value: value ?? null })),
    },
    compareLink('digest', '테스트, 서명, 배포가 같은 이미지 digest를 가리킴', [
      ['배포', d.imageDigest],
      ['테스트', test?.digest ?? null],
      ['정책', plan?.digest ?? null],
      ['서명', sign?.digest ?? null],
      ['배포 결과', deployResult?.digest ?? null],
    ]),
    planHashLink(pr?.planHash ?? plan?.plan_hash ?? null, sign, deployResult),
  ];

  return { conclusion, tone, steps, proof, decision, targets, failoverAllowed, requires, deploy, parsed: { test, plan, sign, deployResult } };
}

function stepFor(name: StageName, label: string, status: string | undefined, word: [string, Tone] | null): StepSummary {
  if (word && status !== 'pending' && status !== 'running') return { name, label, result: word[0], tone: word[1] };
  if (status === 'running') return { name, label, result: '진행 중', tone: 'info' };
  if (status === 'failed') return { name, label, result: '실패', tone: 'danger' };
  if (status === 'skipped') return { name, label, result: '생략', tone: 'muted' };
  if (status === 'succeeded') return { name, label, result: '완료', tone: 'success' };
  return { name, label, result: '대기', tone: 'muted' };
}

function deployWord(display: DeployDisplay, result: DeployResult | null): [string, Tone] | null {
  if (!result) {
    if (display.tone === 'muted') return null;
    return [display.tone === 'danger' ? '시작 안 됨' : '대기', display.tone];
  }
  switch (result.decision) {
    case 'activated':
      return result.routing.result === 'ok' ? ['완료', 'success'] : ['전환 실패', 'danger'];
    case 'held':
      return ['보류', 'warning'];
    case 'rolled_back':
      return ['복구됨', 'warning'];
    case 'error':
      return ['오류', 'danger'];
  }
}

function conclude(view: DeploymentView, decision: Plan['decision'] | null, plan: Plan | null, deploy: DeployDisplay, result: DeployResult | null, steps: StepSummary[]): [string, Tone] {
  const d = view.deployment;
  if (d.status === 'queued') return ['대기 중: 파이프라인이 곧 시작됩니다', 'info'];
  if (d.status === 'running') return [`진행 중: ${steps.find((s) => s.name === d.currentStage)?.label ?? d.currentStage ?? ''} 단계`, 'info'];
  if (d.status === 'awaiting_approval') return ['승인 대기: 사람이 확인해야 배포할 수 있습니다', 'warning'];
  if (d.status === 'blocked' || decision === 'block') {
    const reason = plan?.rules.find((r) => r.result === 'matched')?.reason;
    const ids = (plan?.requires ?? []).map((r) => r.id);
    if (ids.includes('fix_restart_failure') || ids.includes('fix_tests') || ids.includes('investigate_replace_failure')) {
      return ['차단됨: 재시작·교체 후 데이터가 사라집니다', 'danger'];
    }
    return [reason ? `차단됨: ${reason}` : '차단됨: 정책이 배포를 허용하지 않습니다', 'danger'];
  }
  if (result) {
    const r = result.routing;
    switch (result.decision) {
      case 'activated':
        if (r.result === 'ok') {
          const primary = targetLabel(r.kind);
          const standby = r.standby_target_id ? (r.kind === 'onprem' ? ', Cloud Run 대기' : ', On-Prem 대기') : '';
          return [`배포 완료: ${primary}에서 서비스 중${standby}`, 'success'];
        }
        if (r.result === 'error') return ['주의: 새 버전은 떴지만 트래픽 전환에 실패했습니다', 'danger'];
        return ['활성화됨: 트래픽은 아직 바꾸지 않았습니다', 'warning'];
      case 'held':
        return ['안전하게 보류: 새 버전 검사 실패, 기존 서비스 그대로', 'warning'];
      case 'rolled_back':
        return ['이전 버전으로 복구됨: 전환 중 실패를 되돌렸습니다', 'warning'];
      case 'error':
        return [`배포 오류: ${result.error ?? '원인 미기록'}`, 'danger'];
    }
  }
  if (d.status === 'failed') return [`실패: ${d.error ?? deploy.title}`, 'danger'];
  if (d.status === 'succeeded') {
    if (deploy.tone === 'muted') return ['검증 완료: 배포 단계는 생략되어 실제 배포는 없습니다', 'success'];
    return ['완료', 'success'];
  }
  return ['상태를 판정할 수 없습니다', 'muted'];
}

function compareLink(id: ProofLink['id'], title: string, pairs: Array<[string, string | null]>): ProofLink {
  const legs = pairs.map(([label, value]) => ({ label, value }));
  const values = legs.map((l) => l.value).filter((v): v is string => Boolean(v));
  if (values.length < 2) return { id, title, state: 'pending', detail: '비교할 값이 아직 2개 미만', legs };
  const first = values[0]!;
  const same = values.every((v) => v === first);
  return {
    id,
    title,
    state: same ? 'ok' : 'mismatch',
    detail: same ? `${values.length}개 단계의 값이 같음` : '단계 사이 값이 다름. 산출물을 확인해야 함',
    legs,
  };
}

function planHashLink(policyHash: string | null, sign: SignResult | null, result: DeployResult | null): ProofLink {
  const legs = [
    { label: '정책', value: policyHash },
    { label: '서명', value: sign?.plan_hash ?? null },
    { label: '배포 결과', value: result ? (result.signature ? '서명 검증됨' : null) : null },
  ];
  if (!policyHash || !sign) return { id: 'plan_hash', title: '정책 결정서와 서명이 같은 plan_hash를 가리킴', state: 'pending', detail: '정책 또는 서명 결과가 아직 없음', legs };
  if (policyHash !== sign.plan_hash) return { id: 'plan_hash', title: '정책 결정서와 서명이 같은 plan_hash를 가리킴', state: 'mismatch', detail: '정책과 서명의 plan_hash가 다름', legs };
  const deployNote = result ? (result.signature ? '. 배포는 cosign 서명 검증으로 간접 확인 (deploy_result에는 plan_hash가 없음)' : '. 배포 결과에 서명 검증 기록이 없음') : '';
  return { id: 'plan_hash', title: '정책 결정서와 서명이 같은 plan_hash를 가리킴', state: 'ok', detail: `정책과 서명의 plan_hash가 같음${deployNote}`, legs };
}
