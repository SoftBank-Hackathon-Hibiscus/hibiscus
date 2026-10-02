import { Module } from '@nestjs/common';
import { TunnelService } from './tunnel.service.js';
import { TunnelController } from './tunnel.controller.js';
import { AgentModule } from '../agent/agent.module.js';
import { RoutingModule } from '../routing/routing.module.js';

@Module({
  imports: [AgentModule, RoutingModule],
  providers: [TunnelService],
  controllers: [TunnelController],
  exports: [TunnelService],
})
export class TunnelModule {}
