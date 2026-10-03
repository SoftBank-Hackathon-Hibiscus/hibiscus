import type { DataSource } from './client';
import { MockDataSource } from './mock';
import { RealDataSource } from './real';
import { buildScenario, type ScenarioId } from '../mocks';

export type Mode = 'mock' | 'real';

export interface AppConfig {
  mode: Mode;
  scenario: ScenarioId;
}

/**
 * query string 을 읽는다. mode 가 없으면 real (일반 서비스 진입점).
 * 데모는 `?mode=mock&scenario=N` 을 명시해야만 열린다. 기존 리허설 북마크는 그대로 동작한다.
 */
export function readConfig(search: string = window.location.search): AppConfig {
  const params = new URLSearchParams(search);
  const mode: Mode = params.get('mode') === 'mock' ? 'mock' : 'real';
  const raw = Number(params.get('scenario') ?? '1');
  const scenario: ScenarioId = raw === 2 || raw === 3 || raw === 4 || raw === 5 ? raw : 1;
  return { mode, scenario };
}

/** real 은 query 없이 (`''`), mock 은 `?mode=mock&scenario=N`. */
export function configToSearch(config: AppConfig): string {
  if (config.mode === 'real') return '';
  const params = new URLSearchParams();
  params.set('mode', 'mock');
  params.set('scenario', String(config.scenario));
  return `?${params.toString()}`;
}

export function createDataSource(config: AppConfig): DataSource {
  if (config.mode === 'real') return new RealDataSource();
  return new MockDataSource(buildScenario(config.scenario));
}

export { ApiError } from './client';
export type { DataSource } from './client';
export { MockDataSource } from './mock';
