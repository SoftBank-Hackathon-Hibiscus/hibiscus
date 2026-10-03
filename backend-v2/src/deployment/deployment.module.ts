import { Module } from '@nestjs/common';
import { DeploymentController } from './deployment.controller.js';
import { DeploymentService } from './deployment.service.js';
import { DeploymentRepository } from './deployment.repository.js';
import { DatabaseModule } from '../database/database.module.js';
import { ApplicationModule } from '../application/application.module.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import { DeploymentWorker } from './deployment.worker.js';
import { DeploymentArtifactService } from './deployment-artifact.service.js';
import { TestStage } from './stages/test.stage.js';
import { ParityTestStage } from './stages/parity-test.stage.js';
import { PolicyStage } from './stages/policy.stage.js';
import { SignStage } from './stages/sign.stage.js';
import { DeployStage } from './stages/deploy.stage.js';

@Module({
  imports: [DatabaseModule, ApplicationModule],
  controllers: [DeploymentController],
  providers: [
    DeploymentService,
    DeploymentRepository,
    DeploymentWorker,
    DeploymentArtifactService,
    CommandRunner,
    TestStage,
    ParityTestStage,
    PolicyStage,
    SignStage,
    DeployStage,
  ],
  exports: [DeploymentRepository, DeploymentService, CommandRunner],
})
export class DeploymentModule {}
