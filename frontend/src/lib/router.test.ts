import { describe, expect, it } from 'vitest';
import { CONNECT_PATH, DEMOS_PATH, REGISTER_PATH, applicationPath, deploymentPath, hrefFor, parseHash } from './router';

describe('parseHash', () => {
  it('등록 화면은 앱 상세보다 먼저 잡힌다 (/applications/new 가 id 로 읽히지 않음)', () => {
    expect(parseHash(`#${REGISTER_PATH}`)).toEqual({ page: 'register' });
    expect(parseHash('#/applications/new/')).toEqual({ page: 'register' });
  });
  it('앱 목록 / 앱 상세 / 배포 상세', () => {
    expect(parseHash('#/applications')).toEqual({ page: 'applications' });
    expect(parseHash(`#${applicationPath('a4f3')}`)).toEqual({ page: 'application', id: 'a4f3' });
    expect(parseHash(`#${deploymentPath('dep 1')}`)).toEqual({ page: 'deployment', id: 'dep 1' });
  });
  it('홈 / 데모 목록 / 로그인 화면', () => {
    expect(parseHash('#')).toEqual({ page: 'home' });
    expect(parseHash('#/')).toEqual({ page: 'home' });
    expect(parseHash('')).toEqual({ page: 'home' });
    expect(parseHash(`#${DEMOS_PATH}`)).toEqual({ page: 'demos' });
    expect(parseHash('#/demos/')).toEqual({ page: 'demos' });
    expect(parseHash(`#${CONNECT_PATH}`)).toEqual({ page: 'connect' });
  });
  it('모르는 경로는 홈', () => {
    expect(parseHash('#/whatever')).toEqual({ page: 'home' });
  });
});

describe('hrefFor', () => {
  it('데모 안에서는 mode/scenario 를 유지한다', () => {
    expect(hrefFor('/applications/a1', '?mode=mock&scenario=4')).toBe('?mode=mock&scenario=4#/applications/a1');
    expect(hrefFor('/applications/a1', '')).toBe('#/applications/a1');
  });
});
