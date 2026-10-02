// ④ 온프레 장애 → Cloud Run failover. 발표자가 "On-Prem 장애 발생"을 누르면 시작한다 (자동 진행 없음).
//
// health 규칙은 backend-v2 main 의 routing.service.ts recordHealth 를 따른다:
// - 실패가 쌓여도 failureThreshold 에 닿기 전에는 status 가 직전 값(healthy)으로 유지되고 consecutiveFailures 만 늘어난다
//   (이전 기록이 없는 target 만 unknown 이 된다)
// - consecutiveFailures >= failureThreshold 가 되면 unhealthy
// failover 는 health/failover.service.ts 와 같은 조건: 현재 route 가 unhealthy 온프레이고, 같은 deployment 의 healthy
// cloud_run 이 있고, 정책 failoverAllowed 가 true 면 route 를 cloud_run 으로 바꾸고 revision +1. 자동 failback 없음.
// 에이전트는 heartbeat 가 AGENT_OFFLINE_AFTER_MS(기본 30초) 동안 없으면 offline 이 된다.

import { AGENT_ID, AGENT_NAME, agentStatus, applicationView, route, targetView, type HealthInput, type RoutingFrame } from './common';
import { buildAllowDeployment, dep2Targets, servingAgent } from './scenario2-allow-activated';
import type { MockScenario } from './scenario';

export const FAILOVER_TIMING = {
  /** health 확인 주기 (applicationView 의 intervalSeconds 와 같다) */
  intervalMs: 5000,
  /** applicationView 의 failureThreshold */
  failureThreshold: 2,
  /** backend-v2 AGENT_OFFLINE_AFTER_MS 기본값 */
  agentOfflineAfterMs: 30000,
} as const;

interface FailoverState {
  now: number;
  failedAt: number | null;
}

export function buildScenario4(): MockScenario {
  const app = applicationView();
  const { onprem, cloudRun } = dep2Targets();
  const policyFailoverAllowed = true; // buildAllowDeployment 의 policyResult.failoverAllowed
  const networkError = 'connect ECONNREFUSED 127.0.0.1:20001';
  const state: FailoverState = { now: Date.now(), failedAt: null };

  const failures = () => (state.failedAt === null ? 0 : Math.floor((state.now - state.failedAt) / FAILOVER_TIMING.intervalMs) + 1);
  const unhealthy = () => failures() >= FAILOVER_TIMING.failureThreshold;
  const switched = () => unhealthy() && policyFailoverAllowed;
  const agentOffline = () => state.failedAt !== null && state.now - state.failedAt >= FAILOVER_TIMING.agentOfflineAfterMs;

  const onpremHealth = (): HealthInput => {
    const n = failures();
    if (n === 0) return { status: 'healthy', consecutiveSuccesses: 120, observedAt: new Date(state.now).toISOString() };
    return {
      status: unhealthy() ? 'unhealthy' : 'healthy',
      reason: networkError,
      failureKind: 'network',
      consecutiveFailures: n,
      consecutiveSuccesses: 0,
      observedAt: new Date(state.now).toISOString(),
    };
  };
  const cloudHealth = (): HealthInput => ({ status: 'healthy', consecutiveSuccesses: 120 + failures(), observedAt: new Date(state.now).toISOString() });

  const agent = () => {
    if (!agentOffline()) return servingAgent();
    const online = servingAgent();
    const stale = new Date(state.failedAt!).toISOString();
    return agentStatus({ status: 'offline', last_seen_at: stale, updated_at: stale, received_at: stale, serving: online.serving, public_url: online.public_url });
  };

  const frame = (): RoutingFrame => {
    const onpremView = targetView(onprem, onpremHealth());
    const cloudView = targetView(cloudRun, cloudHealth());
    const n = failures();
    const caption =
      state.failedAt === null
        ? '정상 운영. 온프레가 트래픽을 받는 중. "On-Prem 장애 발생"을 누르면 시작'
        : !unhealthy()
          ? `온프레 health 실패 ${n}회. 임계값(${FAILOVER_TIMING.failureThreshold}회) 전이라 상태는 그대로, 전환 없음`
          : switched()
            ? 'route 가 Cloud Run 으로 전환됨 (revision 1 → 2). 자동 failback 없음'
            : '온프레 unhealthy. 정책이 failover 를 막아 전환하지 않음';
    return {
      route: switched() ? route(cloudRun, 2, cloudHealth()) : route(onprem, 1, onpremHealth()),
      targets: [onpremView, cloudView],
      agents: { [AGENT_ID]: agent() },
      caption,
    };
  };

  return {
    id: 4,
    title: '④ 온프레 장애 → failover',
    description: '발표자가 장애를 일으키면 health 실패가 쌓이고, 임계값에 닿으면 route 가 Cloud Run 으로 (revision +1)',
    defaultPath: '/applications/' + app.application.id,
    application: app,
    deployments: [buildAllowDeployment()],
    frames: [frame],
    frameSeconds: 5,
    agentName: AGENT_NAME,
    controls: {
      advance: (now) => {
        state.now = now;
      },
      actions: [
        { id: 'fail-onprem', labelKey: 'failOnprem', run: (now) => { state.failedAt ??= now; state.now = now; }, enabled: () => state.failedAt === null },
        { id: 'reset', labelKey: 'resetScenario', run: (now) => { state.failedAt = null; state.now = now; }, enabled: () => state.failedAt !== null },
      ],
    },
  };
}
