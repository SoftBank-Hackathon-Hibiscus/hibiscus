import type { DataSource } from './client';
import { MockDataSource } from './mock';
import { RealDataSource } from './real';
import { buildScenario, type ScenarioId } from '../mocks';

export type Mode = 'mock' | 'real';

export interface AppConfig {
  mode: Mode;
  scenario: ScenarioId;
}

/** `?mode=mock&scenario=1` 형태의 query string 을 읽는다. 기본은 mock 시나리오 1. */
export function readConfig(search: string = window.location.search): AppConfig {
  const params = new URLSearchParams(search);
  const mode: Mode = params.get('mode') === 'real' ? 'real' : 'mock';
  const raw = Number(params.get('scenario') ?? '1');
  const scenario: ScenarioId = raw === 2 || raw === 3 || raw === 4 || raw === 5 ? raw : 1;
  return { mode, scenario };
}

export function configToSearch(config: AppConfig): string {
  const params = new URLSearchParams();
  params.set('mode', config.mode);
  if (config.mode === 'mock') params.set('scenario', String(config.scenario));
  return `?${params.toString()}`;
}

export function createDataSource(config: AppConfig): DataSource {
  if (config.mode === 'real') return new RealDataSource();
  return new MockDataSource(buildScenario(config.scenario));
}

export { ApiError } from './client';
export type { DataSource } from './client';
export { MockDataSource } from './mock';
