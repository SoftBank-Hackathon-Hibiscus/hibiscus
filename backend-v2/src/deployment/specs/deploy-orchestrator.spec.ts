import { describe, expect, it, vi } from 'vitest';
import type { HealthCheckConfig } from '../../database/schema.js';
import { DeployOrchestrator } from '../deploy/deploy.orchestrator.js';
import {
  DeployRejected,
  type CloudRunPort,
  type DeployInput,
  type HealthCheckerPort,
  type OnpremJobSpec,
  type OnpremPort,
  type RoutingPort,
  type SignatureVerifierPort,
} from '../types/deploy-result.type.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD_DIGEST = `sha256:${'b'.repeat(64)}`;
const RUN = 'run-1';
const REPO = 'registry.example/app';

const healthCheck = {
  applicationId: 'app-1',
  enabled: true,
  path: '/health',
  method: 'GET',
  intervalSeconds: 1,
  timeoutSeconds: 1,
  successStatusMin: 200,
  successStatusMax: 399,
  successThreshold: 1,
  failureThreshold: 1,
  createdAt: '',
  updatedAt: '',
} as HealthCheckConfig;

function input(overrides: Partial<DeployInput> = {}): DeployInput {
  return {
    deploymentId: RUN,
    digest: DIGEST,
    applicationId: 'app-1',
    imageRepo: REPO,
    agentId: 'agent-1',
    healthCheck,
    environment: {},
    changedBy: 'user-1',
    sign: {
      run_id: RUN,
      digest: DIGEST,
      plan_hash: 'b'.repeat(64),
      targets: ['onprem', 'cloud_run'],
      failover_allowed: true,
      requester: 'user-1',
      approver: 'auto',
      signature_ref: `cosign:${REPO}@${DIGEST}`,
      signed_at: '2026-10-02T00:00:00.000Z',
    },
    ...overrides,
  };
}

function setup(
  options: {
    cloudCheckPass?: boolean;
    cloudCandidateFails?: boolean;
    onprem?: (spec: OnpremJobSpec) => Awaited<ReturnType<OnpremPort['run']>>;
    verifierRejects?: boolean;
    withoutCloudRun?: boolean;
    routingFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const verifier: SignatureVerifierPort = {
    verify: vi.fn(async () => {
      calls.push('verify');
      if (options.verifierRejects) throw new DeployRejected('bad signature');
      return { imageRef: `${REPO}@${DIGEST}`, key: '/keys/cosign.pub' };
    }),
  };
  const cloudRun: CloudRunPort = {
    candidate: vi.fn(async () => {
      calls.push('cloud:candidate');
      if (options.cloudCandidateFails) throw new Error('gcloud failed');
      return {
        revision: 'svc-d1',
        candidateUrl: 'https://cand---svc-abc.a.run.app',
      };
    }),
    activate: vi.fn(async () => {
      calls.push('cloud:activate');
      return { previous: 'svc-old', serving: 'svc-d1' };
    }),
    rollback: vi.fn(async (revision: string) => {
      calls.push(`cloud:rollback:${revision}`);
    }),
    discard: vi.fn(async () => {
      calls.push('cloud:discard');
    }),
    serviceUrl: (url: string) => url.replace('://cand---', '://'),
  };
  const health: HealthCheckerPort = {
    check: vi.fn(async (target, baseUrl) => {
      calls.push(`check:${target}`);
      return {
        target,
        mode: 'candidate' as const,
        pass: options.cloudCheckPass ?? true,
        url: baseUrl,
        checker: 'fake',
        checks: [],
      };
    }),
  };
  const onpremRun =
    options.onprem ??
    ((spec: OnpremJobSpec) => ({
      jobId: `${spec.runId}-${spec.action}-01`,
      status: 'succeeded' as const,
      payload: {
        schema_version: 1 as const,
        agent_id: spec.agentId,
        job_id: `${spec.runId}-${spec.action}-01`,
        run_id: spec.runId,
        action: spec.action,
        attempt: 1,
        result: 'ok' as const,
        finished_at: '',
        ...(spec.action === 'candidate'
          ? {
              candidate: {
                digest: DIGEST,
                container: 'hibiscus-run-1',
                url: 'http://127.0.0.1:18081',
              },
              check: { mode: 'candidate', pass: true, checks: [] },
            }
          : {}),
        ...(spec.action === 'activate'
          ? {
              previous: {
                run_id: 'run-old',
                digest: OLD_DIGEST,
                container: 'hibiscus-run-old',
              },
              serving: {
                run_id: RUN,
                digest: DIGEST,
                container: 'hibiscus-run-1',
              },
            }
          : {}),
        ...(spec.action === 'rollback'
          ? {
              serving: {
                run_id: 'run-old',
                digest: spec.toDigest!,
                container: 'hibiscus-run-old',
              },
            }
          : {}),
      },
    }));
  const onprem: OnpremPort = {
    run: vi.fn(async (spec: OnpremJobSpec) => {
      calls.push(`onprem:${spec.action}`);
      return onpremRun(spec);
    }),
  };
  const targets: Record<string, { enabled: boolean }> = {};
  const routing: RoutingPort = {
    ensureTarget: vi.fn((target) => {
      const id = `${target.kind}-target`;
      targets[id] = { enabled: target.enabled };
      calls.push(`route:target:${target.kind}:${target.enabled}`);
      return id;
    }),
    switchTo: vi.fn((_app, targetId) => {
      calls.push(`route:switch:${targetId}`);
      if (options.routingFails)
        throw new Error('Routing revision does not match');
      return 1;
    }),
  };
  const orchestrator = new DeployOrchestrator({
    verifier,
    health,
    routing,
    onprem,
    ...(options.withoutCloudRun
      ? { cloudRunUnavailableReason: 'GCP_PROJECT_ID is not set' }
      : { cloudRun }),
  });
  return { orchestrator, calls, targets };
}

describe('DeployOrchestrator', () => {
  it('activates both targets, Cloud Run first, and routes to on-prem', async () => {
    const { orchestrator, calls, targets } = setup();
    const result = await orchestrator.run(input());

    expect(result.decision).toBe('activated');
    expect(result.signature?.verified).toBe(true);
    expect(calls.indexOf('cloud:activate')).toBeLessThan(
      calls.indexOf('onprem:activate'),
    );
    expect(result.routing).toMatchObject({
      result: 'ok',
      kind: 'onprem',
      target_id: 'onprem-target',
      standby_target_id: 'cloud_run-target',
      standby_enabled: true,
    });
    expect(targets['cloud_run-target'].enabled).toBe(true);
  });

  it('keeps the Cloud Run standby disabled when failover is not allowed', async () => {
    const { orchestrator, targets } = setup();
    const base = input();
    const result = await orchestrator.run(
      input({ sign: { ...base.sign, failover_allowed: false } }),
    );
    expect(result.decision).toBe('activated');
    expect(targets['cloud_run-target'].enabled).toBe(false);
    expect(result.routing.standby_enabled).toBe(false);
  });

  it('routes to Cloud Run when no agent is assigned (on-prem skipped)', async () => {
    const { orchestrator, calls } = setup();
    const result = await orchestrator.run(input({ agentId: null }));
    expect(result.decision).toBe('activated');
    expect(result.targets[1]).toMatchObject({
      target: 'onprem',
      result: 'skipped',
    });
    expect(calls).not.toContain('onprem:candidate');
    expect(result.routing).toMatchObject({ kind: 'cloud_run' });
  });

  it('holds and discards both candidates when a check fails', async () => {
    const { orchestrator, calls } = setup({ cloudCheckPass: false });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('held');
    expect(calls).toContain('cloud:discard');
    expect(calls).toContain('onprem:discard');
    expect(calls).not.toContain('cloud:activate');
    expect(result.routing.result).toBe('skipped');
  });

  it('holds without checks when a candidate cannot start', async () => {
    const { orchestrator, calls } = setup({ cloudCandidateFails: true });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('held');
    expect(calls).not.toContain('check:cloud_run');
    expect(calls).toContain('cloud:discard');
    expect(calls).toContain('onprem:discard');
  });

  it('rolls Cloud Run back when on-prem activation fails', async () => {
    const { orchestrator, calls } = setup({
      onprem: (spec) =>
        spec.action === 'activate'
          ? { jobId: 'job', status: 'failed', error: 'proxy failed' }
          : {
              jobId: `${spec.runId}-${spec.action}-01`,
              status: 'succeeded',
              payload: {
                schema_version: 1,
                agent_id: 'agent-1',
                job_id: 'job',
                run_id: RUN,
                action: spec.action,
                attempt: 1,
                result: 'ok',
                finished_at: '',
                candidate: {
                  digest: DIGEST,
                  container: 'c',
                  url: 'http://127.0.0.1:18081',
                },
              },
            },
    });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('rolled_back');
    expect(calls).toContain('cloud:rollback:svc-old');
    expect(calls).toContain('onprem:discard');
    expect(result.routing.result).toBe('skipped');
  });

  it('rolls both targets back when the routing switch fails', async () => {
    const { orchestrator, calls } = setup({ routingFails: true });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('rolled_back');
    expect(result.routing).toMatchObject({
      result: 'error',
      error: 'Routing revision does not match',
    });
    expect(result.error).toContain('Routing switch failed');
    expect(calls).toContain('cloud:rollback:svc-old');
    expect(calls).toContain('onprem:rollback');
    expect(
      result.targets.filter((step) => step.phase === 'rollback'),
    ).toMatchObject([
      { target: 'cloud_run', result: 'ok', serving: 'svc-old' },
      { target: 'onprem', result: 'ok', serving: 'hibiscus-run-old' },
    ]);
  });

  it('rolls Cloud Run back when routing fails without an agent', async () => {
    const { orchestrator, calls } = setup({ routingFails: true });
    const result = await orchestrator.run(input({ agentId: null }));
    expect(result.decision).toBe('rolled_back');
    expect(calls).toContain('cloud:rollback:svc-old');
    expect(calls).not.toContain('onprem:rollback');
  });

  it('reports an error when routing fails and the agent had nothing to roll back to', async () => {
    const { orchestrator, calls } = setup({
      routingFails: true,
      onprem: (spec) => ({
        jobId: `${spec.runId}-${spec.action}-01`,
        status: 'succeeded',
        payload: {
          schema_version: 1,
          agent_id: 'agent-1',
          job_id: `${spec.runId}-${spec.action}-01`,
          run_id: RUN,
          action: spec.action,
          attempt: 1,
          result: 'ok',
          finished_at: '',
          ...(spec.action === 'candidate'
            ? {
                candidate: {
                  digest: DIGEST,
                  container: 'c',
                  url: 'http://127.0.0.1:18081',
                },
                check: { mode: 'candidate', pass: true, checks: [] },
              }
            : {}),
        },
      }),
    });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('error');
    expect(calls).toContain('cloud:rollback:svc-old');
    expect(calls).not.toContain('onprem:rollback');
    expect(
      result.targets.find(
        (step) => step.target === 'onprem' && step.phase === 'rollback',
      ),
    ).toMatchObject({ result: 'error' });
  });

  it('rejects before touching any target when the signature is invalid', async () => {
    const { orchestrator, calls } = setup({ verifierRejects: true });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('error');
    expect(result.error).toBe('bad signature');
    expect(calls).toEqual(['verify']);
  });

  it('rejects a sign_result for another deployment without verifying', async () => {
    const { orchestrator, calls } = setup();
    const base = input();
    const result = await orchestrator.run(
      input({ sign: { ...base.sign, run_id: 'other-run' } }),
    );
    expect(result.decision).toBe('error');
    expect(calls).toEqual([]);
  });

  it('refuses cloud_run targets when Cloud Run is not configured', async () => {
    const { orchestrator, calls } = setup({ withoutCloudRun: true });
    const result = await orchestrator.run(input());
    expect(result.decision).toBe('error');
    expect(result.error).toContain('GCP_PROJECT_ID');
    expect(calls).toEqual([]);
  });
});
