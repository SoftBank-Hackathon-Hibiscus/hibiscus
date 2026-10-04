import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module.js';
import { DeploymentModule } from '../deployment/deployment.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ObservabilityModule } from './observability.module.js';
import { ConsoleController } from './console.controller.js';
import { ConsoleService } from './console.service.js';
@Module({
  imports: [
    ApplicationModule,
    DeploymentModule,
    RoutingModule,
    ObservabilityModule,
  ],
  controllers: [ConsoleController],
  providers: [ConsoleService],
})
export class ConsoleModule {}
