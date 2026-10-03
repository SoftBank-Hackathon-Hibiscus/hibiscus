import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types/auth.type.js';
import {
  IdParamDto,
  UpdateApplicationEnvironmentDto,
} from '../application/dto/application.dto.js';
import { ApplicationService } from '../application/application.service.js';
import {
  ApproveDeploymentDto,
  CreateDeploymentDto,
  DeploymentIdParamDto,
} from './dto/deployment.dto.js';
import { DeploymentService } from './deployment.service.js';

@Controller()
export class DeploymentController {
  constructor(
    private readonly service: DeploymentService,
    private readonly applications: ApplicationService,
  ) {}

  @Post('applications/:id/deployments')
  create(
    @Param() params: IdParamDto,
    @Body() input: CreateDeploymentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.create(params.id, input, request.user.id);
  }

  @Get('applications/:id/deployments')
  list(@Param() params: IdParamDto) {
    return this.service.list(params.id);
  }

  @Get('deployments/:id')
  get(@Param() params: DeploymentIdParamDto) {
    return this.service.get(params.id);
  }

  @Post('deployments/:id/approve')
  approve(
    @Param() params: DeploymentIdParamDto,
    @Body() _input: ApproveDeploymentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.approve(params.id, request.user.id);
  }

  @Post('deployments/:id/cancel')
  cancel(
    @Param() params: DeploymentIdParamDto,
    @Body() _input: ApproveDeploymentDto,
  ) {
    return this.service.cancel(params.id);
  }

  @Post('deployments/:id/rollback')
  rollback(
    @Param() params: DeploymentIdParamDto,
    @Body() _input: ApproveDeploymentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.rollback(params.id, request.user.id);
  }

  @Put('applications/:id/environment')
  updateEnvironment(
    @Param() params: IdParamDto,
    @Body() input: UpdateApplicationEnvironmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const sourceRevision = this.service.latestSourceRevision(params.id);
    const updated = this.applications.updateEnvironment(params.id, input);
    const deployment = this.service.create(
      params.id,
      { source_revision: sourceRevision },
      request.user.id,
    );
    return { ...updated, deployment };
  }

  @Put('applications/:id/test-environment')
  updateTestEnvironment(
    @Param() params: IdParamDto,
    @Body() input: UpdateApplicationEnvironmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const sourceRevision = this.service.latestSourceRevision(params.id);
    const updated = this.applications.updateTestEnvironment(params.id, input);
    const deployment = this.service.create(
      params.id,
      { source_revision: sourceRevision },
      request.user.id,
    );
    return { ...updated, deployment };
  }
}
