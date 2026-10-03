import { describe, expect, it } from 'vitest';
import { REGISTER_PATH, applicationPath, deploymentPath, parseHash } from './router';

describe('parseHash', () => {
  it('등록 화면은 앱 상세보다 먼저 잡힌다 (/applications/new 가 id 로 읽히지 않음)', () => {
    expect(parseHash(`#${REGISTER_PATH}`)).toEqual({ page: 'register' });
    expect(parseHash('#/applications/new/')).toEqual({ page: 'register' });
  });
  it('앱 목록 / 앱 상세 / 배포 상세', () => {
    expect(parseHash('#/applications')).toEqual({ page: 'applications' });
    expect(parseHash(`#${applicationPath('a4f3')}`)).toEqual({ page: 'application', id: 'a4f3' });
    expect(parseHash(`#${deploymentPath('dep 1')}`)).toEqual({ page: 'deployment', id: 'dep 1' });
    expect(parseHash('#')).toEqual({ page: 'none' });
  });
});
