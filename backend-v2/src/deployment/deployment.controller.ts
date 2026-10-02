import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types/auth.type.js';
import { IdParamDto } from '../application/dto/application.dto.js';
import {
  ApproveDeploymentDto,
  CreateDeploymentDto,
  DeploymentIdParamDto,
} from './dto/deployment.dto.js';
import { DeploymentService } from './deployment.service.js';

@Controller()
export class DeploymentController {
  constructor(private readonly service: DeploymentService) {}

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
}
