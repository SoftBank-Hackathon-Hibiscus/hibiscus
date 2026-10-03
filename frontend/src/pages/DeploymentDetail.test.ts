import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDataSource } from '../api/mock';
import { RealDataSource } from '../api/real';
import { usePolling } from '../hooks/usePolling';
import { LangProvider } from '../lib/i18n';
import { buildScenario } from '../mocks';
import { DeploymentDetail } from './DeploymentDetail';

vi.mock('../hooks/usePolling', () => ({ usePolling: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('window', { location: { pathname: '/', search: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('배포 상세의 저장된 진단 표시', () => {
  it.each(['real', 'mock'] as const)('%s 모드에서는 별도 실행의 진단을 올바르게 구분한다', (kind) => {
    const scenario = buildScenario(1);
    const view = scenario.deployments[0]!;
    vi.mocked(usePolling).mockReturnValue({
      data: view,
      error: null,
      loading: false,
      lastUpdated: null,
      refresh: vi.fn(),
    });
    const source = kind === 'mock' ? new MockDataSource(scenario) : new RealDataSource();
    const markup = renderToStaticMarkup(
      createElement(LangProvider, null, createElement(DeploymentDetail, { id: view.deployment.id, source })),
    );

    expect(markup.includes('href="/diagnosis/guestbook.html"')).toBe(kind === 'mock');
    expect(markup.includes('저장된 LLM 진단 보기')).toBe(kind === 'mock');
  });
});
