import { buildScenario1 } from './scenario1-guestbook-block';
import { buildScenario2 } from './scenario2-allow-activated';
import { buildScenario3 } from './scenario3-held';
import { buildScenario4 } from './scenario4-failover';
import { buildScenario5 } from './scenario5-approval';
import type { MockScenario, ScenarioId } from './scenario';

export type { MockScenario, ScenarioId, ScenarioControls } from './scenario';

export const SCENARIO_IDS: ScenarioId[] = [1, 2, 3, 4, 5];

export function buildScenario(id: ScenarioId): MockScenario {
  switch (id) {
    case 1:
      return buildScenario1();
    case 2:
      return buildScenario2();
    case 3:
      return buildScenario3();
    case 4:
      return buildScenario4();
    case 5:
      return buildScenario5();
  }
}

export function scenarioSummaries(): Array<Pick<MockScenario, 'id' | 'title' | 'description' | 'defaultPath'>> {
  return SCENARIO_IDS.map((id) => {
    const s = buildScenario(id);
    return { id: s.id, title: s.title, description: s.description, defaultPath: s.defaultPath };
  });
}
