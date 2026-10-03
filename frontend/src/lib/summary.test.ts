import { describe, expect, it } from 'vitest';
import type { StageExecution } from '../api/types';
import { summarizeDeployment } from './summary';
import { makeAllowView, makeDeployResult, makeStage, makeView } from '../test/fixtures';

const proofOf = (view: ReturnType<typeof makeView>, id: 'run_id' | 'source' | 'digest' | 'plan_hash') => summarizeDeployment(view, 'ko').proof.find((p) => p.id === id)!;

describe('summarizeDeployment: 증명 체인', () => {
  it('서명까지 끝난 allow 는 같은 배포 요청·같은 이미지·같은 결정이 확인', () => {
    const view = makeAllowView();
    expect(proofOf(view, 'run_id').state).toBe('ok');
    expect(proofOf(view, 'digest').state).toBe('ok');
    expect(proofOf(view, 'plan_hash').state).toBe('ok');
  });

  it('validationError 가 있는 산출물은 성공 근거로 쓰지 않는다', () => {
    const view = makeAllowView({ testValidationError: 'test_result does not match the current deployment' });
    const summary = summarizeDeployment(view, 'ko');
    expect(summary.parsed.test).toBeNull();
    // 테스트 결과가 빠져도 정책·서명 값만으로는 비교가 되므로 ok 가 될 수 있다. 테스트 결과를 근거로 쓰지 않았는지 확인
    const digest = proofOf(view, 'digest');
    expect(digest.legs.find((l) => l.label === '테스트')?.value).toBeNull();
  });

  it('digest 가 다른 산출물이 있으면 불일치', () => {
    const view = makeAllowView();
    const sign = view.artifacts.find((a) => a.name === 'sign_result')!;
    sign.content = sign.content.replace('a'.repeat(64), 'b'.repeat(64));
    expect(proofOf(view, 'digest').state).toBe('mismatch');
  });

  it('차단된 실행은 같은 결정이 해당 없음', () => {
    const view = makeView({ deployment: { ...makeAllowView().deployment, status: 'blocked', decision: 'block' } });
    expect(proofOf(view, 'plan_hash').state).toBe('na');
  });

  it('sourceRevisionVerified 가 true 여도 테스트가 stub 이면 확인 전', () => {
    const view = makeAllowView({ deployment: { sourceRevisionVerified: true } });
    view.stages[0]!.summary = { stub: true, template: 'allow' };
    expect(proofOf(view, 'source').state).toBe('pending');
  });

  it('sourceRevisionVerified 가 true 이고 실제 테스트면 확인', () => {
    const view = makeAllowView({ deployment: { sourceRevisionVerified: true } });
    expect(proofOf(view, 'source').state).toBe('ok');
  });
});

describe('summarizeDeployment: 배포 판정', () => {
  const deployStage = (patch: Partial<StageExecution> = {}) => makeStage({ ...patch, stage: 'deploy' });

  it('activated + routing ok 는 성공', () => {
    const view = makeAllowView({ deployStage: deployStage(), deployResult: makeDeployResult() });
    const s = summarizeDeployment(view, 'ko');
    expect(s.tone).toBe('success');
    expect(s.steps[3]?.tone).toBe('success');
  });

  it('held 는 주황이고 기존 서비스 유지 문구', () => {
    const view = makeAllowView({
      deployment: { status: 'failed', deploymentPerformed: false },
      deployStage: deployStage({ status: 'failed', exitCode: 3 }),
      deployResult: makeDeployResult({ decision: 'held', routing: { result: 'skipped' }, checks: [{ target: 'cloud_run', mode: 'candidate', pass: false, checker: 'http-health', checks: [] }] }),
    });
    const s = summarizeDeployment(view, 'ko');
    expect(s.tone).toBe('warning');
    expect(s.conclusion).toContain('기존 서비스');
    expect(s.deployLines.join(' ')).toContain('Cloud Run: 실패');
  });

  it('rolled_back + routing error 는 주황, 되돌림 문구', () => {
    const view = makeAllowView({
      deployment: { status: 'failed', deploymentPerformed: false },
      deployStage: deployStage({ status: 'failed', exitCode: 4 }),
      deployResult: makeDeployResult({ decision: 'rolled_back', routing: { result: 'error', error: 'Routing revision does not match' }, targets: [{ target: 'cloud_run', phase: 'rollback', result: 'ok' }] }),
    });
    const s = summarizeDeployment(view, 'ko');
    expect(s.tone).toBe('warning');
    expect(s.deployLines[0]).toContain('되돌렸어요');
    expect(s.deployLines.join(' ')).toContain('Cloud Run: 이전 버전으로 되돌렸어요');
  });

  it('rolled_back 은 대상별로 serving 에 남은 되돌린 값을 보여준다', () => {
    const view = makeAllowView({
      deployment: { status: 'failed', deploymentPerformed: false },
      deployStage: deployStage({ status: 'failed', exitCode: 4 }),
      deployResult: makeDeployResult({
        decision: 'rolled_back',
        routing: { result: 'error', error: 'Routing revision does not match' },
        targets: [
          { target: 'cloud_run', phase: 'rollback', result: 'ok', serving: 'guestbook-00001-abc' },
          { target: 'onprem', phase: 'rollback', result: 'ok', job_id: 'job-9', serving: 'hibiscus-dep-0001-guestbook' },
        ],
      }),
    });
    const s = summarizeDeployment(view, 'ko');
    expect(s.deployLines).toContain('Cloud Run: 이전 버전으로 되돌렸어요 (guestbook-00001-abc)');
    expect(s.deployLines).toContain('On-Prem: 이전 버전으로 되돌렸어요 (hibiscus-dep-0001-guestbook)');
    expect(s.deploy.details).toEqual(['Cloud Run 을 guestbook-00001-abc 로 되돌림', 'On-Prem 을 hibiscus-dep-0001-guestbook 로 되돌림']);
  });

  it('error + rollback 실패는 빨강이고 Cloud Run 경고', () => {
    const view = makeAllowView({
      deployment: { status: 'failed', deploymentPerformed: false },
      deployStage: deployStage({ status: 'failed', exitCode: 1 }),
      deployResult: makeDeployResult({ decision: 'error', routing: { result: 'error', error: 'x' }, targets: [{ target: 'cloud_run', phase: 'activate', result: 'ok' }, { target: 'cloud_run', phase: 'rollback', result: 'error', error: 'boom' }] }),
    });
    const s = summarizeDeployment(view, 'ko');
    expect(s.tone).toBe('danger');
    expect(s.deployLines.join(' ')).toContain('Cloud Run');
  });

  it('activated + routing error 는 방어용으로 빨강', () => {
    const view = makeAllowView({ deployStage: deployStage(), deployResult: makeDeployResult({ routing: { result: 'error', error: 'x' } }) });
    const s = summarizeDeployment(view, 'ko');
    expect(s.tone).toBe('danger');
    expect(s.steps[3]?.tone).toBe('danger');
  });

  it('DEPLOY_MODE=off 생략은 배포됨이라 하지 않는다', () => {
    const view = makeAllowView({ deployment: { deploymentPerformed: false }, deployStage: deployStage({ status: 'skipped', summary: { mode: 'off', reason: '실제 배포 조율기를 호출하지 않음' } }) });
    const s = summarizeDeployment(view, 'ko');
    expect(s.conclusion).not.toContain('배포했습니다');
    expect(s.deployLines[0]).toContain('건너뛰었어요');
  });

  it('차단이면 서명·배포 단계는 진행 안 함', () => {
    const base = makeAllowView();
    const view = makeView({ deployment: { ...base.deployment, status: 'blocked', decision: 'block' }, stages: base.stages.slice(0, 2), artifacts: base.artifacts.slice(0, 2), policyResult: { ...base.policyResult!, decision: 'block', targets: [], failoverAllowed: false } });
    const s = summarizeDeployment(view, 'ko');
    expect(s.tone).toBe('danger');
    expect(s.steps[2]?.result).toContain('진행하지 않았어요');
    expect(s.steps[3]?.result).toContain('진행하지 않았어요');
  });
});
