import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
} from '@nestjs/common';
import { AssignAgentParamDto, CreateAgentDto } from './dto/agent.dto.js';
import { AgentService } from './agent.service.js';
import { AgentJobService } from './agent-job.service.js';
import { AgentIdParamDto } from './dto/agent-heartbeat.dto.js';
import {
  AgentAdminJobParamDto,
  CreateAgentJobDto,
} from './dto/agent-job.dto.js';
import { AgentSshService } from './agent-ssh.service.js';

@Controller()
export class AgentController {
  constructor(
    private readonly service: AgentService,
    private readonly jobs: AgentJobService,
    private readonly ssh: AgentSshService,
  ) {}

  @Post('agents')
  @Header('Cache-Control', 'no-store')
  create(@Body() input: CreateAgentDto) {
    return this.service.create(input);
  }

  @Get('agents')
  list() {
    return this.service.list();
  }

  @Get('agents/:id')
  get(@Param() params: AgentIdParamDto) {
    return this.service.get(params.id);
  }

  @Post('agents/:id/token/rotate')
  @Header('Cache-Control', 'no-store')
  rotateToken(@Param() params: AgentIdParamDto) {
    return this.service.rotateToken(params.id);
  }

  @Delete('agents/:id/token')
  revokeToken(@Param() params: AgentIdParamDto) {
    return this.service.revokeToken(params.id);
  }

  @Post('agents/:id/ssh/enrollment')
  @Header('Cache-Control', 'no-store')
  createSshEnrollment(@Param() params: AgentIdParamDto) {
    return this.ssh.createEnrollment(params.id);
  }

  @Get('agents/:id/status')
  status(@Param() params: AgentIdParamDto) {
    return this.service.status(params.id);
  }

  @Post('agents/:id/jobs')
  createJob(
    @Param() params: AgentIdParamDto,
    @Body() input: CreateAgentJobDto,
  ) {
    return this.jobs.create(params.id, input);
  }

  @Get('agents/:id/jobs')
  listJobs(@Param() params: AgentIdParamDto) {
    return this.jobs.list(params.id);
  }

  @Get('agents/:id/jobs/:jobId')
  getJob(@Param() params: AgentAdminJobParamDto) {
    return this.jobs.get(params.id, params.jobId);
  }

  @Delete('applications/:id/agents/:agentId')
  unassign(@Param() params: AssignAgentParamDto) {
    return this.service.unassign(params.id, params.agentId);
  }

  @Post('applications/:id/agents/:agentId')
  assign(@Param() params: AssignAgentParamDto) {
    return this.service.assign(params.id, params.agentId);
  }
}
