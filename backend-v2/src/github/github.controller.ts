import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  SetMetadata,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { GithubService } from './github.service.js';
import {
  GithubApplicationDto,
  GithubCommitsQueryDto,
  GithubBranchDto,
  GithubPageDto,
  GithubRepositoriesQueryDto,
  GithubRepositoryParamDto,
} from './dto/github.dto.js';
import { IdParamDto } from '../application/dto/application.dto.js';
import { PUBLIC_ROUTE } from '../auth/types/auth.type.js';
import type { AuthenticatedRequest } from '../auth/types/auth.type.js';

@Controller('github')
export class GithubController {
  constructor(private readonly github: GithubService) {}

  @Get('connection')
  connection(@Req() request: AuthenticatedRequest) {
    return this.github.connection(request.user.id);
  }

  @Get('installations')
  installations(
    @Req() request: AuthenticatedRequest,
    @Query() query: GithubPageDto,
  ) {
    return this.github.installations(request.user.id, query);
  }

  @Get('repositories')
  repositories(
    @Req() request: AuthenticatedRequest,
    @Query() query: GithubRepositoriesQueryDto,
  ) {
    return this.github.repositories(request.user.id, query);
  }

  @Get('repositories/:repositoryId/branches')
  branches(
    @Req() request: AuthenticatedRequest,
    @Param() params: GithubRepositoryParamDto,
    @Query() query: GithubRepositoriesQueryDto,
  ) {
    return this.github.branches(request.user.id, params.repositoryId, query);
  }

  @Get('applications/:id/commits')
  commits(
    @Req() request: AuthenticatedRequest,
    @Param() params: IdParamDto,
    @Query() query: GithubCommitsQueryDto,
  ) {
    return this.github.commits(request.user.id, params.id, query);
  }

  @Post('applications')
  create(
    @Req() request: AuthenticatedRequest,
    @Body() input: GithubApplicationDto,
  ) {
    return this.github.createApplication(request.user.id, input);
  }

  @Patch('applications/:id/branch')
  branch(
    @Req() request: AuthenticatedRequest,
    @Param() params: IdParamDto,
    @Body() input: GithubBranchDto,
  ) {
    return this.github.updateBranch(request.user.id, params.id, input);
  }

  @Post('webhooks')
  @HttpCode(200)
  @SetMetadata(PUBLIC_ROUTE, true)
  webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-delivery') delivery: string,
    @Headers('x-github-event') event: string,
  ) {
    return this.github.webhook(request.rawBody, signature, delivery, event);
  }
}
