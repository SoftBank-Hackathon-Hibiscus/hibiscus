import { describe, expect, it } from 'vitest';
import { MockDataSource } from '../api/mock';
import { detectRouteChange, markOf } from '../lib/failover';
import { APP_ID, AGENT_ID } from './common';
import { FAILOVER_TIMING, buildScenario4 } from './scenario4-failover';

function setup() {
  let now = 2_000_000;
  const source = new MockDataSource(buildScenario4(), () => now, 0);
  return { source, tick: (ms: number) => (now += ms) };
}

const onpremOf = async (source: MockDataSource) => (await source.getTargets(APP_ID)).find((t) => t.target.kind === 'onprem')!;

describe('시나리오 ④ On-Prem 장애 → failover (main recordHealth 규칙)', () => {
  it('조작 전에는 healthy 이고 route 는 온프레 rev 1', async () => {
    const { source } = setup();
    expect((await onpremOf(source)).health?.status).toBe('healthy');
    const routing = await source.getRouting(APP_ID);
    expect(routing.target.kind).toBe('onprem');
    expect(routing.revision).toBe(1);
    expect(source.actions().find((a) => a.id === 'fail-onprem')?.enabled()).toBe(true);
  });

  it('첫 실패는 임계값 전이라 status 가 healthy 로 유지되고 consecutiveFailures 만 1', async () => {
    const { source } = setup();
    source.runAction('fail-onprem');
    const onprem = await onpremOf(source);
    expect(onprem.health?.status).toBe('healthy');
    expect(onprem.health?.consecutiveFailures).toBe(1);
    expect(onprem.health?.failureKind).toBe('network');
    expect((await source.getRouting(APP_ID)).revision).toBe(1);
  });

  it('임계값(2회)에 닿으면 unhealthy 가 되고 route 가 Cloud Run rev 2 로 바뀐다', async () => {
    const { source, tick } = setup();
    source.runAction('fail-onprem');
    const before = markOf(await source.getRouting(APP_ID));
    tick(FAILOVER_TIMING.intervalMs * (FAILOVER_TIMING.failureThreshold - 1));
    const onprem = await onpremOf(source);
    expect(onprem.health?.status).toBe('unhealthy');
    expect(onprem.health?.consecutiveFailures).toBe(FAILOVER_TIMING.failureThreshold);
    const routing = await source.getRouting(APP_ID);
    expect(routing.target.kind).toBe('cloud_run');
    expect(routing.revision).toBe(2);
    expect(routing.target.deploymentId).toBe(before!.deploymentId);
    const change = detectRouteChange(before, markOf(routing));
    expect(change?.failover).toBe(true);
  });

  it('에이전트는 30초 동안 heartbeat 가 없을 때 offline', async () => {
    const { source, tick } = setup();
    source.runAction('fail-onprem');
    tick(FAILOVER_TIMING.agentOfflineAfterMs - 1000);
    expect((await source.getAgentStatus(AGENT_ID)).status).toBe('online');
    tick(2000);
    expect((await source.getAgentStatus(AGENT_ID)).status).toBe('offline');
  });

  it('reset 하면 처음 상태로 돌아간다', async () => {
    const { source, tick } = setup();
    source.runAction('fail-onprem');
    tick(FAILOVER_TIMING.intervalMs * 3);
    expect((await source.getRouting(APP_ID)).revision).toBe(2);
    source.runAction('reset');
    expect((await source.getRouting(APP_ID)).revision).toBe(1);
    expect((await onpremOf(source)).health?.status).toBe('healthy');
    expect(source.actions().find((a) => a.id === 'fail-onprem')?.enabled()).toBe(true);
  });
});
