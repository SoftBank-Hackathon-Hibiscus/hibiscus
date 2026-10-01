import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/types/auth.type.js';
import {
  ApplicationRoutingParamDto,
  CreateRoutingTargetDto,
  UpdateApplicationRouteDto,
} from './dto/routing.dto.js';
import { RoutingService } from './routing.service.js';

@Controller('applications/:id')
export class RoutingController {
  constructor(private readonly service: RoutingService) {}

  @Post('targets')
  createTarget(
    @Param() params: ApplicationRoutingParamDto,
    @Body() input: CreateRoutingTargetDto,
  ) {
    return this.service.createTarget(params.id, input);
  }

  @Get('targets')
  listTargets(@Param() params: ApplicationRoutingParamDto) {
    return this.service.listTargets(params.id);
  }

  @Get('routing')
  getRoute(@Param() params: ApplicationRoutingParamDto) {
    return this.service.getRoute(params.id);
  }

  @Patch('routing')
  changeRoute(
    @Param() params: ApplicationRoutingParamDto,
    @Body() input: UpdateApplicationRouteDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.changeRoute(params.id, input, request.user.id);
  }
}
