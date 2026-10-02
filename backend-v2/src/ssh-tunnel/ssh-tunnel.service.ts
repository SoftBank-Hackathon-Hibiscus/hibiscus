import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type Socket } from 'node:net';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { RoutingTarget } from '../database/schema.js';
import { RoutingRepository } from '../routing/routing.repository.js';

@Injectable()
export class SshTunnelService {
  constructor(
    private readonly routing: RoutingRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  open(target: RoutingTarget): Promise<Socket> {
    if (target.kind !== 'onprem' || !target.gatewayPort) {
      return Promise.reject(new Error('SSH forward target is invalid'));
    }
    return this.connect(target.gatewayPort);
  }

  async status(agentId: string) {
    const targets = this.routing.listAgentForwards(agentId);
    const forwards = await Promise.all(
      targets.map(async (target) => ({
        target_id: target.id,
        gateway_port: target.gatewayPort,
        local_port: target.localPort,
        connected: target.gatewayPort
          ? await this.isReachable(target.gatewayPort)
          : false,
      })),
    );
    return {
      connected: forwards.some((forward) => forward.connected),
      active_forwards: forwards.filter((forward) => forward.connected).length,
      forwards,
    };
  }

  private connect(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const timer = setTimeout(
        () => {
          socket.destroy();
          reject(new Error('SSH forward connection timed out'));
        },
        this.config.get('backend.sshForwardConnectTimeoutMs', { infer: true }),
      );
      timer.unref();
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async isReachable(port: number): Promise<boolean> {
    try {
      const socket = await this.connect(port);
      socket.destroy();
      return true;
    } catch {
      return false;
    }
  }
}
