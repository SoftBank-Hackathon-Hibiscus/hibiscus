import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { AgentRepository } from './agent.repository.js';
import { DatabaseModule } from '../database/database.module.js';
import { ApplicationModule } from '../application/application.module.js';
import { AgentRuntimeController } from './agent-runtime.controller.js';
import { AgentJobService } from './agent-job.service.js';
import { AgentJobRepository } from './agent-job.repository.js';
import { AgentTokenGuard } from './guards/agent-token.guard.js';
import { DeploymentModule } from '../deployment/deployment.module.js';

@Module({
  imports: [DatabaseModule, ApplicationModule, DeploymentModule],
  controllers: [AgentController, AgentRuntimeController],
  providers: [
    AgentService,
    AgentRepository,
    AgentJobService,
    AgentJobRepository,
    AgentTokenGuard,
  ],
  exports: [AgentService],
})
export class AgentModule {}
