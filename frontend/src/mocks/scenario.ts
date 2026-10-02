import type { ApplicationView, Deployment, DeploymentView } from '../api/types';
import type { RoutingFrame } from './common';

export type ScenarioId = 1 | 2 | 3 | 4 | 5;

/** 시나리오가 시간이나 조작에 따라 상태를 바꿀 때 쓰는 훅. 없으면 정적 시나리오. */
export interface ScenarioControls {
  /** 매 요청 전에 호출. now 는 ms */
  advance?: (now: number) => void;
  /** POST /deployments/:id/approve 를 흉내낸다. 조건이 맞지 않으면 ApiError 를 던진다 */
  approve?: (deploymentId: string, now: number) => Deployment;
  /** 발표자 조작 (mock 전용). 라벨 키는 i18n 키 */
  actions?: Array<{ id: string; labelKey: 'failOnprem' | 'resetScenario'; run: (now: number) => void; enabled: () => boolean }>;
}

export interface MockScenario {
  id: ScenarioId;
  title: string;
  description: string;
  /** 해시 라우트 (예: /deployments/<id>) */
  defaultPath: string;
  application: ApplicationView;
  deployments: DeploymentView[];
  /** 시간 순 프레임. frameSeconds 마다 다음 프레임으로 넘어가고 마지막에 머문다. 호출 시점에 만들어 health 관측 시각이 신선하게 유지된다 */
  frames: Array<() => RoutingFrame>;
  frameSeconds: number;
  agentName: string;
  controls?: ScenarioControls;
}
