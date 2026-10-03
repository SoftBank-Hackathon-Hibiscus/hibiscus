import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { IdParamDto } from '../application/dto/application.dto.js';
import { ApplicationService } from '../application/application.service.js';
import { RoutingRepository } from '../routing/routing.repository.js';
import { ConsoleService } from './console.service.js';
import { TrafficService } from './traffic.service.js';
import { LogsQueryDto, TrafficQueryDto } from './dto/console.dto.js';
@Controller('applications/:id')
export class ConsoleController {
  constructor(
    private readonly apps: ApplicationService,
    private readonly traffic: TrafficService,
    private readonly console: ConsoleService,
    private readonly routing: RoutingRepository,
  ) {}
  @Get('traffic')
  getTraffic(@Param() params: IdParamDto, @Query() query: TrafficQueryDto) {
    this.apps.get(params.id);
    return this.traffic.snapshot(params.id, query.seconds);
  }
  @Get('logs')
  @Header('Cache-Control', 'no-store')
  getLogs(@Param() params: IdParamDto, @Query() query: LogsQueryDto) {
    return this.console.readLogs(params.id, query);
  }
  @Get('routing/history')
  getRoutingHistory(@Param() params: IdParamDto) {
    this.apps.get(params.id);
    return this.routing.history(params.id);
  }
}
