import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HealthCheckConfig,
  RoutingTarget,
} from '../../database/schema.js';
import type { SshTunnelService } from '../../ssh-tunnel/ssh-tunnel.service.js';
import { TargetHealthProbeService } from '../target-health-probe.service.js';

describe('TargetHealthProbeService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('classifies an HTTP status failure as an application failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    const result = await service().check(target(), healthConfig());

    expect(result).toEqual({
      status: 'unhealthy',
      reason: 'HTTP 503',
      failureKind: 'application',
    });
  });

  it('classifies a connection failure as a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect failed'),
    );

    const result = await service().check(target(), healthConfig());

    expect(result).toEqual({
      status: 'unhealthy',
      reason: 'connect failed',
      failureKind: 'network',
    });
  });
});

function service(): TargetHealthProbeService {
  return new TargetHealthProbeService({} as SshTunnelService);
}

function target(): RoutingTarget {
  const now = new Date().toISOString();
  return {
    id: 'target-1',
    applicationId: 'app-1',
    deploymentId: 'run-1',
    kind: 'cloud_run',
    agentId: null,
    localPort: null,
    gatewayPort: null,
    url: 'https://example.run.app',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function healthConfig(): HealthCheckConfig {
  const now = new Date().toISOString();
  return {
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
    createdAt: now,
    updatedAt: now,
  };
}
