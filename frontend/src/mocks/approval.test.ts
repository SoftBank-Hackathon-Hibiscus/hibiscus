import { describe, expect, it } from 'vitest';
import { MockDataSource, MOCK_USER } from '../api/mock';
import { ApiError } from '../api/client';
import { summarizeDeployment } from '../lib/summary';
import { APPROVAL_TIMELINE, DEP5_ID, TARGET_ONPREM_V5, buildScenario5 } from './scenario5-approval';
import { APP_ID } from './common';

function setup() {
  let now = 1_000_000;
  const source = new MockDataSource(buildScenario5(), () => now, 0);
  return { source, tick: (ms: number) => (now += ms) };
}

describe('시나리오 ⑤ 승인 대기 → 승인 → 서명 → 배포', () => {
  it('승인 전: awaiting_approval, test·policy 만 실행, 서명·배포 단계 없음', async () => {
    const { source } = setup();
    const view = await source.getDeployment(DEP5_ID);
    expect(view.deployment.status).toBe('awaiting_approval');
    expect(view.deployment.decision).toBe('needs_approval');
    expect(view.deployment.approver).toBeNull();
    expect(view.deployment.deploymentPerformed).toBe(false);
    expect(view.stages.map((s) => s.stage)).toEqual(['test', 'policy']);
    expect(view.policyResult?.targets).toEqual(['onprem', 'cloud_run']);
    expect(view.policyResult?.failoverAllowed).toBe(true);
    const summary = summarizeDeployment(view, 'ko');
    expect(summary.steps[2]?.result).not.toContain('서명했어요');
    expect(summary.requires[0]?.unlocks).toEqual(['onprem', 'cloud_run']);
  });

  it('승인 전에는 route 가 v2 온프레(rev 1)', async () => {
    const { source } = setup();
    const routing = await source.getRouting(APP_ID);
    expect(routing.revision).toBe(1);
    expect(routing.target.deploymentId).not.toBe(DEP5_ID);
  });

  it('승인하면 approver 가 기록되고 running 으로 바뀐다', async () => {
    const { source } = setup();
    const approved = await source.approveDeployment(DEP5_ID);
    expect(approved.status).toBe('running');
    expect(approved.approver).toBe(MOCK_USER.id);
    expect(approved.currentStage).toBe('sign');
  });

  it('두 번 승인하면 409', async () => {
    const { source } = setup();
    await source.approveDeployment(DEP5_ID);
    await expect(source.approveDeployment(DEP5_ID)).rejects.toMatchObject({ status: 409 });
  });

  it('승인 뒤 시간이 지나면 서명 → 배포 → activated 로 넘어간다', async () => {
    const { source, tick } = setup();
    await source.approveDeployment(DEP5_ID);

    tick(APPROVAL_TIMELINE.signStart + 100);
    let view = await source.getDeployment(DEP5_ID);
    expect(view.stages.find((s) => s.stage === 'sign')?.status).toBe('running');
    expect(view.stages.find((s) => s.stage === 'deploy')).toBeUndefined();

    tick(APPROVAL_TIMELINE.signDone - APPROVAL_TIMELINE.signStart);
    view = await source.getDeployment(DEP5_ID);
    expect(view.stages.find((s) => s.stage === 'sign')?.status).toBe('succeeded');
    expect(view.artifacts.some((a) => a.name === 'sign_result')).toBe(true);
    expect(view.artifacts.some((a) => a.name === 'approval')).toBe(true);
    expect(view.auditLogs.some((l) => l.kind === 'sign')).toBe(true);
    expect(view.stages.find((s) => s.stage === 'deploy')?.status).toBe('running');
    expect(view.deployment.status).toBe('running');
    expect(view.deployment.deploymentPerformed).toBe(false);
    let summary = summarizeDeployment(view, 'ko');
    expect(summary.steps[3]?.result).toBe('진행 중이에요');

    tick(APPROVAL_TIMELINE.deployDone - APPROVAL_TIMELINE.signDone);
    view = await source.getDeployment(DEP5_ID);
    expect(view.deployment.status).toBe('succeeded');
    expect(view.deployment.deploymentPerformed).toBe(true);
    expect(view.stages.find((s) => s.stage === 'deploy')?.status).toBe('succeeded');
    const deployResult = view.artifacts.find((a) => a.name === 'deploy_result');
    expect(deployResult).toBeDefined();
    expect(JSON.parse(deployResult!.content).decision).toBe('activated');
    summary = summarizeDeployment(view, 'ko');
    expect(summary.tone).toBe('success');
    expect(summary.proof.every((p) => p.state === 'ok')).toBe(true);

    const routing = await source.getRouting(APP_ID);
    expect(routing.revision).toBe(2);
    expect(routing.target.id).toBe(TARGET_ONPREM_V5);
    expect(routing.target.deploymentId).toBe(DEP5_ID);
  });

  it('다른 배포(v2 완료)는 승인할 수 없다', async () => {
    const { source } = setup();
    const others = (await source.listDeployments(APP_ID)).filter((d) => d.id !== DEP5_ID);
    await expect(source.approveDeployment(others[0]!.id)).rejects.toBeInstanceOf(ApiError);
  });
});
