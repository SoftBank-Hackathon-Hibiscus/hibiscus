import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDataSource } from '../api/mock';
import { RealDataSource } from '../api/real';
import type { TestResult } from '../api/contracts';
import type { DeploymentView } from '../api/types';
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

function realGuestbookView(edit?: (result: TestResult) => void): DeploymentView {
  const view = buildScenario(1).deployments[0]!;
  for (const artifact of view.artifacts.filter((a) => a.name === 'test_result')) {
    const result = JSON.parse(artifact.content) as TestResult;
    result.app = 'parity-guestbook';
    edit?.(result);
    artifact.content = JSON.stringify(result);
  }
  return view;
}

function renderReal(view: DeploymentView, lang = 'ko') {
  vi.stubGlobal('localStorage', { getItem: () => lang });
  vi.mocked(usePolling).mockReturnValue({
    data: view, error: null, loading: false, lastUpdated: null, refresh: vi.fn(),
  });
  return renderToStaticMarkup(
    createElement(LangProvider, null, createElement(DeploymentDetail, { id: view.deployment.id, source: new RealDataSource() })),
  );
}

describe('배포 상세의 저장된 진단 표시', () => {
  it.each([
    ['real', 'ko'], ['mock', 'ko'], ['real', 'ja'], ['mock', 'ja'],
  ] as const)('%s 모드·%s 언어에서는 별도 실행의 진단을 올바르게 구분한다', (kind, lang) => {
    vi.stubGlobal('localStorage', { getItem: () => lang });
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

    expect(markup.includes(`href="/diagnosis/guestbook.html?lang=${lang}"`)).toBe(kind === 'mock');
    expect(markup.includes(lang === 'ja' ? '保存済みLLM診断を見る' : '저장된 LLM 진단 보기')).toBe(kind === 'mock');
  });

  it.each(['ko', 'ja'])('real의 같은 방명록 실패 패턴에 별도 실행 안내와 %s 링크를 표시한다', (lang) => {
    const view = realGuestbookView();
    const before = structuredClone(view);
    const markup = renderReal(view, lang);
    expect(markup).toContain(`href="/diagnosis/guestbook.html?lang=${lang}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(lang === 'ja' ? '同じ失敗パターンのLLM診断例を見る' : '같은 실패 패턴의 LLM 진단 사례 보기');
    expect(markup).toContain(lang === 'ja' ? '現在のデプロイの診断ではありません。' : '현재 배포의 진단은 아닙니다.');
    expect(view).toEqual(before);
  });

  it('진단 링크와 함께 실제 단계 오류 출력을 유지한다', () => {
    const view = realGuestbookView();
    const stage = view.stages.find((s) => s.stage === 'test')!;
    stage.summary = { stub: false, stderr_tail: 'guestbook replay mismatch' };
    const markup = renderReal(view);
    expect(markup).toContain('/diagnosis/guestbook.html?lang=ko');
    expect(markup).toContain('guestbook replay mismatch');
  });

  const differentCases: Array<[string, (result: TestResult) => void]> = [
    ['다른 앱', (r) => { r.app = 'demo-app'; }],
    ['이름에 guestbook이 포함된 다른 앱', (r) => { r.app = 'parity-guestbook-fixed'; }],
    ['성공한 검사', (r) => { r.passed = true; }],
    ['정상 실행부터 실패', (r) => { r.match.matched = 19; }],
    ['다른 실패 수', (r) => { r.facts!.conditions![1]!.matched = 13; }],
    ['같은 실패 수지만 다른 요청', (r) => { r.facts!.conditions![1]!.mismatches[0]!.request = 'GET /health'; }],
    ['같은 요청이지만 다른 순번', (r) => { r.facts!.conditions![1]!.mismatches[0]!.index = 10; }],
    ['실패 요청 중복', (r) => { const ms = r.facts!.conditions![1]!.mismatches; ms[0] = { ...ms[1]! }; }],
    ['교체 조건 누락', (r) => { r.facts!.conditions!.pop(); }],
    ['조건별 기록 없음', (r) => { delete r.facts; }],
  ];
  it.each(differentCases)('%s에는 저장된 진단을 붙이지 않는다', (_label, edit) => {
    expect(renderReal(realGuestbookView(edit))).not.toContain('/diagnosis/guestbook.html');
  });

  it.each(['stub', 'invalid', 'missing'] as const)('%s 결과에는 같은 패턴이어도 진단을 붙이지 않는다', (kind) => {
    const view = realGuestbookView();
    if (kind === 'stub') view.stages.find((s) => s.stage === 'test')!.summary = { stub: true };
    if (kind === 'invalid') {
      for (const artifact of view.artifacts.filter((a) => a.name === 'test_result')) artifact.validationError = 'digest mismatch';
    }
    if (kind === 'missing') view.artifacts = view.artifacts.filter((a) => a.name !== 'test_result');
    expect(renderReal(view)).not.toContain('/diagnosis/guestbook.html');
  });
});
