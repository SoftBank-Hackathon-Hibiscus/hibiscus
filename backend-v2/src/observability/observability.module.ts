import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { TrafficService } from './traffic.service.js';
import { RuntimeLogsService } from './runtime-logs.service.js';
import { LogRedactionService } from './log-redaction.service.js';
@Module({
  imports: [DatabaseModule],
  providers: [TrafficService, RuntimeLogsService, LogRedactionService],
  exports: [TrafficService, RuntimeLogsService, LogRedactionService],
})
export class ObservabilityModule {}
