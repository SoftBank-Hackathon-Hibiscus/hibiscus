import { Controller, Get, Param } from '@nestjs/common';
import { AgentService } from '../agent/agent.service.js';
import { AgentIdParamDto } from '../agent/dto/agent-heartbeat.dto.js';
import { SshTunnelService } from './ssh-tunnel.service.js';

@Controller('agents/:id/tunnel')
export class SshTunnelController {
  constructor(
    private readonly tunnel: SshTunnelService,
    private readonly agents: AgentService,
  ) {}

  @Get()
  status(@Param() params: AgentIdParamDto) {
    this.agents.get(params.id);
    return this.tunnel.status(params.id);
  }
}
