import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service.js';
import { RoutingController } from './routing.controller.js';
import { DatabaseModule } from '../database/database.module.js';
import { ApplicationModule } from '../application/application.module.js';
import { DeploymentModule } from '../deployment/deployment.module.js';
import { AgentModule } from '../agent/agent.module.js';
import { RoutingRepository } from './routing.repository.js';

@Module({
  imports: [DatabaseModule, ApplicationModule, DeploymentModule, AgentModule],
  providers: [RoutingService, RoutingRepository],
  controllers: [RoutingController],
  exports: [RoutingService, RoutingRepository],
})
export class RoutingModule {}
