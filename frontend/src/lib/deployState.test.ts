import { describe, expect, it } from 'vitest';
import type { DeployResult } from '../api/contracts';
import { deriveDeployDisplay } from './deployState';
import { makeDeployResult, makeStage } from '../test/fixtures';

// backend-v2 deploy.orchestrator 기준: rollback 성공 step 은 serving 에 복구 대상을 기록하고 previous 는 쓰지 않는다
const stage = makeStage({ stage: 'deploy', status: 'failed', exitCode: 4 });
const rolledBack = (targets: DeployResult['targets']) =>
  makeDeployResult({ decision: 'rolled_back', routing: { result: 'error', error: 'Routing revision does not match' }, error: 'Routing switch failed', targets });

describe('deriveDeployDisplay: rolled_back', () => {
  it('Cloud Run rollback 성공은 serving 의 revision 을 보여준다', () => {
    const d = deriveDeployDisplay(stage, rolledBack([
      { target: 'cloud_run', phase: 'activate', result: 'ok', previous: 'svc-00012', serving: 'svc-00013' },
      { target: 'cloud_run', phase: 'rollback', result: 'ok', serving: 'svc-00012' },
    ]));
    expect(d.tone).toBe('warning');
    expect(d.details).toContain('Cloud Run 을 svc-00012 로 되돌림');
    expect(d.details.join(' ')).not.toContain('svc-00013');
  });

  it('On-Prem rollback 성공은 serving 의 container 를 보여준다', () => {
    const d = deriveDeployDisplay(stage, rolledBack([
      { target: 'onprem', phase: 'activate', result: 'ok', job_id: 'j1', previous: 'hib-app-a1', serving: 'hib-app-b2' },
      { target: 'onprem', phase: 'rollback', result: 'ok', job_id: 'j2', serving: 'hib-app-a1' },
    ]));
    expect(d.details).toContain('On-Prem 을 hib-app-a1 로 되돌림');
    expect(d.details.join(' ')).not.toContain('hib-app-b2');
  });

  it('둘 다 되돌렸으면 둘 다 보여준다', () => {
    const d = deriveDeployDisplay(stage, rolledBack([
      { target: 'cloud_run', phase: 'rollback', result: 'ok', serving: 'svc-00012' },
      { target: 'onprem', phase: 'rollback', result: 'ok', job_id: 'j2', serving: 'hib-app-a1' },
    ]));
    expect(d.details).toContain('Cloud Run 을 svc-00012 로 되돌림');
    expect(d.details).toContain('On-Prem 을 hib-app-a1 로 되돌림');
  });

  it('serving 값이 없으면 대상을 만들어내지 않고 미기록으로 표시한다', () => {
    const d = deriveDeployDisplay(stage, rolledBack([
      { target: 'onprem', phase: 'activate', result: 'ok', previous: 'hib-app-a1', serving: 'hib-app-b2' },
      { target: 'onprem', phase: 'rollback', result: 'ok', job_id: 'j2', serving: null },
    ]));
    expect(d.details).toContain('On-Prem 되돌림 (복구 후 서빙 대상 미기록)');
    // activate step 의 previous 를 복구 대상으로 빌려 쓰지 않는다
    expect(d.details.join(' ')).not.toContain('hib-app-a1');
    expect(d.details.join(' ')).not.toContain('hib-app-b2');
  });

  it('rollback 실패 step 은 되돌림으로 표시하지 않는다', () => {
    const d = deriveDeployDisplay(stage, rolledBack([
      { target: 'cloud_run', phase: 'rollback', result: 'ok', serving: 'svc-00012' },
      { target: 'onprem', phase: 'rollback', result: 'error', error: 'No previous container was serving on the agent' },
    ]));
    expect(d.details).toContain('Cloud Run 을 svc-00012 로 되돌림');
    expect(d.details.join(' ')).not.toContain('On-Prem 을');
    expect(d.details.join(' ')).not.toContain('On-Prem 되돌림');
  });
});
