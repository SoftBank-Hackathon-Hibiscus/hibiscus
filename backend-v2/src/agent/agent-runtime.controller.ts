import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentService } from './agent.service.js';
import { AgentJobService } from './agent-job.service.js';
import { AgentTokenGuard } from './guards/agent-token.guard.js';
import { AgentHeartbeatDto } from './dto/agent-heartbeat.dto.js';
import { AgentJobParamDto, AgentJobResultDto } from './dto/agent-job.dto.js';
import { AGENT_ROUTE } from './types/agent.type.js';
import type { AgentRequest } from './types/agent.type.js';

@Controller('agent/v1')
@SetMetadata(AGENT_ROUTE, true)
@UseGuards(AgentTokenGuard)
export class AgentRuntimeController {
  constructor(
    private readonly agents: AgentService,
    private readonly jobs: AgentJobService,
  ) {}

  @Get('jobs/next')
  @Header('Cache-Control', 'no-store')
  next(
    @Req() request: AgentRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const job = this.jobs.next(request.agent.id);
    if (!job) response.status(204);
    return job;
  }

  @Post('jobs/:jobId/result')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  result(
    @Req() request: AgentRequest,
    @Param() params: AgentJobParamDto,
    @Body() input: AgentJobResultDto,
  ) {
    return this.jobs.submit(request.agent.id, params.jobId, input);
  }

  @Post('heartbeat')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  heartbeat(@Req() request: AgentRequest, @Body() input: AgentHeartbeatDto) {
    return this.agents.heartbeat(request.agent.id, input);
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@Req() request: AgentRequest) {
    return this.agents.status(request.agent.id);
  }
}
