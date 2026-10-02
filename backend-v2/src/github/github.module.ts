import { Module } from '@nestjs/common';
import { GithubController } from './github.controller.js';
import { GithubService } from './github.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { UserModule } from '../user/user.module.js';
import { ApplicationModule } from '../application/application.module.js';
import { DeploymentModule } from '../deployment/deployment.module.js';

@Module({
  imports: [DatabaseModule, UserModule, ApplicationModule, DeploymentModule],
  controllers: [GithubController],
  providers: [GithubService],
})
export class GithubModule {}
