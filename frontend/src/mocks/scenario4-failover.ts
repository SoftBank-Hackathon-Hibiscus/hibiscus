// ④ 온프레 장애 → Cloud Run failover
// 순서는 backend-v2/test/app.e2e-spec.ts 의 failover 테스트를 따른다:
// healthy → (1회 실패) unknown, consecutiveFailures 1 → (2회) unhealthy → route 가 cloud_run 으로, revision 1 → 2.
// 터널 끊김만으로는 전환하지 않고, 자동 failback 도 없다.

import { AGENT_ID, AGENT_NAME, agentStatus, applicationView, route, targetView, type RoutingFrame } from './common';
import { buildAllowDeployment, dep2Targets, servingAgent } from './scenario2-allow-activated';
import type { MockScenario } from './scenario';

export function buildScenario4(): MockScenario {
  const { onprem, cloudRun } = dep2Targets();
  const networkError = 'connect ECONNREFUSED 127.0.0.1:20001';

  // 터널이 끊겨 heartbeat 가 멈춘 에이전트. 마지막으로 보고한 서빙 정보는 그대로 남는다.
  const offlineAgent = () => {
    const stale = new Date(Date.now() - 45_000).toISOString();
    const online = servingAgent();
    return agentStatus({
      status: 'offline',
      last_seen_at: stale,
      updated_at: stale,
      received_at: stale,
      serving: online.serving,
      public_url: online.public_url,
    });
  };

  const frames: Array<() => RoutingFrame> = [
    () => ({
      route: route(onprem, 1, { status: 'healthy', consecutiveSuccesses: 120 }),
      targets: [
        targetView(onprem, { status: 'healthy', consecutiveSuccesses: 120 }),
        targetView(cloudRun, { status: 'healthy', consecutiveSuccesses: 120 }),
      ],
      agents: { [AGENT_ID]: servingAgent() },
      caption: '정상 운영. 온프레가 트래픽을 받는 중',
    }),
    () => ({
      route: route(onprem, 1, { status: 'unknown', reason: networkError, failureKind: 'network', consecutiveFailures: 1 }),
      targets: [
        targetView(onprem, { status: 'unknown', reason: networkError, failureKind: 'network', consecutiveFailures: 1 }),
        targetView(cloudRun, { status: 'healthy', consecutiveSuccesses: 121 }),
      ],
      agents: { [AGENT_ID]: servingAgent() },
      caption: '온프레 health 1회 실패. 임계값(2) 미달이라 unknown, 전환 없음',
    }),
    () => ({
      route: route(onprem, 1, { status: 'unhealthy', reason: networkError, failureKind: 'network', consecutiveFailures: 2 }),
      targets: [
        targetView(onprem, { status: 'unhealthy', reason: networkError, failureKind: 'network', consecutiveFailures: 2 }),
        targetView(cloudRun, { status: 'healthy', consecutiveSuccesses: 122 }),
      ],
      agents: { [AGENT_ID]: offlineAgent() },
      caption: '온프레 health 2회 연속 실패 → unhealthy. Health Monitor 가 failover 판단',
    }),
    () => ({
      route: route(cloudRun, 2, { status: 'healthy', consecutiveSuccesses: 123 }),
      targets: [
        targetView(onprem, { status: 'unhealthy', reason: networkError, failureKind: 'network', consecutiveFailures: 3 }),
        targetView(cloudRun, { status: 'healthy', consecutiveSuccesses: 123 }),
      ],
      agents: { [AGENT_ID]: offlineAgent() },
      caption: 'route 가 Cloud Run 으로 전환됨 (revision 1 → 2). 자동 failback 없음',
    }),
  ];

  return {
    id: 4,
    title: '④ 온프레 장애 → failover',
    description: '온프레 health unknown → unhealthy, route 가 Cloud Run 으로 (revision +1). 5초마다 진행',
    defaultPath: '/applications/' + applicationView().application.id,
    application: applicationView(),
    deployments: [buildAllowDeployment()],
    frames,
    frameSeconds: 5,
    agentName: AGENT_NAME,
  };
}
