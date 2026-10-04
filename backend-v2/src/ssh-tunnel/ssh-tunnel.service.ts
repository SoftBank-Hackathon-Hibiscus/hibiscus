import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type Socket } from 'node:net';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { RoutingTarget } from '../database/schema.js';
import { SshConnectionStateService } from './ssh-connection-state.service.js';
import { SshTunnelEndpointService } from './ssh-tunnel-endpoint.service.js';
import { RoutingRepository } from '../routing/routing.repository.js';

@Injectable()
export class SshTunnelService {
  constructor(
    private readonly state: SshConnectionStateService,
    private readonly endpoint: SshTunnelEndpointService,
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
    const session = this.state.snapshot(agentId);
    const forwards = targets.map((target) => ({
      target_id: target.id,
      application_id: target.applicationId,
      deployment_id: target.deploymentId,
      gateway_port: target.gatewayPort,
      local_port: target.localPort,
      connected:
        session.connected && session.bound_ports.includes(target.gatewayPort!),
      health:
        this.routing
          .listTargets(target.applicationId)
          .find((t) => t.target.id === target.id)?.health ?? null,
    }));
    const reportState = session.report?.state;
    return {
      ...session,
      state: session.connected
        ? 'connected'
        : reportState === 'connecting' || reportState === 'reconnecting'
          ? reportState
          : targets.length === 0
            ? 'idle'
            : 'disconnected',
      endpoint: this.endpoint.connection(),
      requested_forwards: targets.length,
      active_forwards: forwards.filter((f) => f.connected).length,
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
}
