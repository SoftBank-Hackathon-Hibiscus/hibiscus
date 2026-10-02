import { Injectable } from '@nestjs/common';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import type { HealthCheckConfig, RoutingTarget } from '../database/schema.js';
import { SshTunnelService } from '../ssh-tunnel/ssh-tunnel.service.js';
import type { TargetProbeResult } from './types/health.type.js';

@Injectable()
export class TargetHealthProbeService {
  constructor(private readonly tunnel: SshTunnelService) {}

  async check(
    target: RoutingTarget,
    config: HealthCheckConfig,
  ): Promise<TargetProbeResult> {
    try {
      const status =
        target.kind === 'onprem'
          ? await this.checkOnPrem(target, config)
          : await this.checkCloudRun(target, config);
      const healthy =
        status >= config.successStatusMin && status <= config.successStatusMax;
      return {
        status: healthy ? 'healthy' : 'unhealthy',
        reason: `HTTP ${status}`,
        ...(healthy ? {} : { failureKind: 'application' as const }),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        reason: error instanceof Error ? error.message : 'Health probe failed',
        failureKind: 'network',
      };
    }
  }

  private async checkCloudRun(
    target: RoutingTarget,
    config: HealthCheckConfig,
  ): Promise<number> {
    const url = new URL(config.path, target.url!);
    const response = await fetch(url, {
      method: config.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeoutSeconds * 1_000),
    });
    await response.body?.cancel();
    return response.status;
  }

  private async checkOnPrem(
    target: RoutingTarget,
    config: HealthCheckConfig,
  ): Promise<number> {
    const stream = await this.tunnel.open(target);
    const agent = new HttpAgent({ keepAlive: false });
    agent.createConnection = () => stream as Socket;
    return new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          method: config.method,
          host: 'onprem.internal',
          path: config.path,
          agent,
        },
        (incoming) => {
          incoming.resume();
          incoming.once('end', () => resolve(incoming.statusCode ?? 0));
        },
      );
      const timer = setTimeout(() => {
        outgoing.destroy(new Error('Health probe timed out'));
      }, config.timeoutSeconds * 1_000);
      timer.unref();
      outgoing.once('close', () => clearTimeout(timer));
      outgoing.once('error', reject);
      outgoing.end();
    });
  }
}
