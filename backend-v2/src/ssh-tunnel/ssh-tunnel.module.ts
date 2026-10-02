import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { SshTunnelController } from './ssh-tunnel.controller.js';
import { SshTunnelService } from './ssh-tunnel.service.js';

@Module({
  imports: [AgentModule, RoutingModule],
  controllers: [SshTunnelController],
  providers: [SshTunnelService],
  exports: [SshTunnelService],
})
export class SshTunnelModule {}
