import type { ApplicationView, DeploymentView } from '../api/types';
import type { RoutingFrame } from './common';

export type ScenarioId = 1 | 2 | 3 | 4;

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
}
