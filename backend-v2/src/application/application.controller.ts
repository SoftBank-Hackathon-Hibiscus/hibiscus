import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  CreateApplicationDto,
  IdParamDto,
  UpdateApplicationEnvironmentDto,
  UpdateHealthCheckDto,
} from './dto/application.dto.js';
import { ApplicationService } from './application.service.js';

@Controller('applications')
export class ApplicationController {
  constructor(private readonly service: ApplicationService) {}

  @Post()
  create(@Body() input: CreateApplicationDto) {
    return this.service.create(input);
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param() params: IdParamDto) {
    return this.service.get(params.id);
  }

  @Patch(':id/health-check')
  updateHealthCheck(
    @Param() params: IdParamDto,
    @Body() input: UpdateHealthCheckDto,
  ) {
    return this.service.updateHealthCheck(params.id, input);
  }

  @Put(':id/environment')
  updateEnvironment(
    @Param() params: IdParamDto,
    @Body() input: UpdateApplicationEnvironmentDto,
  ) {
    return this.service.updateEnvironment(params.id, input);
  }
}
