import { describe, expect, it } from 'vitest';
import type { HealthCheckConfig } from '../api/types';
import { healthCheckDraft, toHealthCheckInput, validateHealthCheck } from './healthCheck';

const config: HealthCheckConfig = {
  applicationId: 'app-1',
  enabled: true,
  path: '/health',
  versionPath: null,
  method: 'GET',
  intervalSeconds: 5,
  timeoutSeconds: 2,
  successStatusMin: 200,
  successStatusMax: 399,
  successThreshold: 1,
  failureThreshold: 3,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
};

describe('Health Check form', () => {
  it('API 응답을 편집한 뒤 Backend 입력 형식으로 변환한다', () => {
    const draft = healthCheckDraft(config);
    draft.path = ' /ready ';
    draft.versionPath = '';
    draft.failureThreshold = '5';

    expect(validateHealthCheck(draft)).toEqual({});
    expect(toHealthCheckInput(draft)).toEqual({
      enabled: true,
      path: '/ready',
      version_path: null,
      method: 'GET',
      interval_seconds: 5,
      timeout_seconds: 2,
      success_status_min: 200,
      success_status_max: 399,
      success_threshold: 1,
      failure_threshold: 5,
    });
  });

  it('잘못된 경로와 Backend의 교차 필드 조건을 막는다', () => {
    const draft = healthCheckDraft(config);
    draft.path = 'https://example.com/health';
    draft.intervalSeconds = '2';
    draft.timeoutSeconds = '3';
    draft.successStatusMin = '400';
    draft.successStatusMax = '399';

    expect(validateHealthCheck(draft)).toEqual({
      path: 'path',
      timeoutSeconds: 'timeoutOrder',
      successStatusMax: 'statusOrder',
    });
  });

  it('숫자 범위를 검사한다', () => {
    const draft = healthCheckDraft(config);
    draft.intervalSeconds = '0';
    draft.timeoutSeconds = '61';
    draft.successStatusMin = '99';
    draft.successThreshold = '21';
    draft.failureThreshold = '1.5';

    expect(validateHealthCheck(draft)).toMatchObject({
      intervalSeconds: 'interval',
      timeoutSeconds: 'timeout',
      successStatusMin: 'status',
      successThreshold: 'threshold',
      failureThreshold: 'threshold',
    });
  });
});
