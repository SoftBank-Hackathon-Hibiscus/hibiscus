import { describe, expect, it } from 'vitest';
import type { DeploymentArtifact, DeploymentView, StageExecution } from '../api/types';
import { findArtifact, latestStages, parseJsonArtifact } from './artifacts';

function stage(patch: Partial<StageExecution>): StageExecution {
  return {
    id: 's1',
    deploymentId: 'd1',
    sequence: 1,
    attempt: 1,
    stage: 'test',
    status: 'succeeded',
    exitCode: 0,
    startedAt: '2026-10-03T00:00:00.000Z',
    finishedAt: '2026-10-03T00:00:01.000Z',
    artifacts: {},
    summary: null,
    error: null,
    ...patch,
  };
}

function artifact(patch: Partial<DeploymentArtifact>): DeploymentArtifact {
  return {
    id: 'a1',
    deploymentId: 'd1',
    stageExecutionId: 's1',
    name: 'plan',
    relativePath: 'policy/plan.json',
    mediaType: 'application/json',
    content: '{}',
    contentHash: 'x',
    schemaName: null,
    validationError: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    ...patch,
  };
}

describe('latestStages', () => {
  it('같은 stage 에 attempt 가 여러 개면 가장 큰 attempt 만 남긴다', () => {
    const latest = latestStages([
      stage({ id: 's1', stage: 'sign', attempt: 1, status: 'failed' }),
      stage({ id: 's3', stage: 'sign', attempt: 3, status: 'running' }),
      stage({ id: 's2', stage: 'sign', attempt: 2, status: 'succeeded' }),
    ]);
    expect(latest.sign?.id).toBe('s3');
  });

  it('stage 별로 각각 최신 attempt 를 고른다', () => {
    const latest = latestStages([
      stage({ id: 't1', stage: 'test', attempt: 1 }),
      stage({ id: 't2', stage: 'test', attempt: 2 }),
      stage({ id: 'p1', stage: 'policy', attempt: 1 }),
      stage({ id: 'd1', stage: 'deploy', attempt: 1 }),
      stage({ id: 'd2', stage: 'deploy', attempt: 2 }),
    ]);
    expect(latest.test?.id).toBe('t2');
    expect(latest.policy?.id).toBe('p1');
    expect(latest.sign).toBeUndefined();
    expect(latest.deploy?.id).toBe('d2');
  });

  it('빈 목록이면 빈 객체', () => {
    expect(latestStages([])).toEqual({});
  });
});

describe('findArtifact', () => {
  const view = {
    artifacts: [
      artifact({ id: 'p1', stageExecutionId: 'policy-1', name: 'plan', content: '{"decision":"block"}' }),
      artifact({ id: 'p2', stageExecutionId: 'policy-2', name: 'plan', content: '{"decision":"allow"}' }),
      artifact({ id: 'tr', stageExecutionId: 'test-1', name: 'test_result' }),
    ],
  } as unknown as DeploymentView;

  it('같은 이름이 여러 개면 마지막(최신 시도)', () => {
    expect(findArtifact(view, 'plan')?.id).toBe('p2');
  });

  it('단계 실행을 주면 그 단계 것을 우선한다', () => {
    expect(findArtifact(view, 'plan', stage({ id: 'policy-1', stage: 'policy' }))?.id).toBe('p1');
  });

  it('없으면 undefined', () => {
    expect(findArtifact(view, 'deploy_result')).toBeUndefined();
  });
});

describe('parseJsonArtifact', () => {
  it('JSON 원문을 읽는다', () => {
    const parsed = parseJsonArtifact<{ decision: string }>(artifact({ content: '{"decision":"allow"}' }));
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) expect(parsed.value.decision).toBe('allow');
  });

  it('깨진 JSON 은 ok:false 와 raw', () => {
    const parsed = parseJsonArtifact(artifact({ content: '{oops' }));
    expect(parsed?.ok).toBe(false);
    if (parsed && !parsed.ok) expect(parsed.raw).toBe('{oops');
  });

  it('text/plain 은 parse 하지 않는다', () => {
    const parsed = parseJsonArtifact(artifact({ mediaType: 'text/plain', name: 'explain.ko', content: '# 제목' }));
    expect(parsed?.ok).toBe(false);
    if (parsed && !parsed.ok) expect(parsed.raw).toBe('# 제목');
  });

  it('validationError 가 있으면 JSON 이 멀쩡해도 ok:false 이고 error 로 전달한다', () => {
    const parsed = parseJsonArtifact<{ decision: string }>(artifact({ content: '{"decision":"allow"}', validationError: 'plan does not match the current deployment' }));
    expect(parsed?.ok).toBe(false);
    if (parsed && !parsed.ok) {
      expect(parsed.error).toBe('plan does not match the current deployment');
      expect(parsed.raw).toBe('{"decision":"allow"}');
    }
  });

  it('없으면 undefined', () => {
    expect(parseJsonArtifact(undefined)).toBeUndefined();
  });
});
