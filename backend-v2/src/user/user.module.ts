import { Module } from '@nestjs/common';
import { UserController } from './user.controller.js';
import { UserService } from './user.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { GithubConnectionService } from '../github/github-connection.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [UserController],
  providers: [UserService, GithubConnectionService],
  exports: [UserService, GithubConnectionService],
})
export class UserModule {}
