import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { SshTunnelController } from './ssh-tunnel.controller.js';
import { SshTunnelService } from './ssh-tunnel.service.js';
import { SshTunnelAuthService } from './ssh-tunnel-auth.service.js';
import { SshTunnelCoreModule } from './ssh-tunnel-core.module.js';
import { SshTunnelServerService } from './ssh-tunnel-server.service.js';

@Module({
  imports: [AgentModule, RoutingModule, SshTunnelCoreModule],
  controllers: [SshTunnelController],
  providers: [SshTunnelService, SshTunnelAuthService, SshTunnelServerService],
  exports: [SshTunnelService],
})
export class SshTunnelModule {}
