import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { isUUID, validateSync } from 'class-validator';
import type { AuthConfig } from '../config/configs/auth.config.js';
import { DatabaseService } from '../database/database.service.js';
import {
  applications,
  githubApplicationLinks,
  githubWebhookDeliveries,
  githubCredentials,
  users,
} from '../database/schema.js';
import { ApplicationService } from '../application/application.service.js';
import { DeploymentService } from '../deployment/deployment.service.js';
import { GithubConnectionService } from './github-connection.service.js';
import {
  GithubPushDto,
  GithubRepositoryDto,
  GithubBranchResponseDto,
  GithubIdDto,
} from './dto/github.dto.js';
import type {
  GithubApplicationDto,
  GithubCommitsQueryDto,
  GithubBranchDto,
  GithubPageDto,
  GithubRepositoriesQueryDto,
} from './dto/github.dto.js';
import type {
  GithubCommitResponse,
  GithubInstallation,
  GithubRepositories,
  GithubRepository,
} from './types/github.type.js';

@Injectable()
export class GithubService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<AuthConfig, true>,
    private readonly connectionService: GithubConnectionService,
    private readonly applicationsService: ApplicationService,
    private readonly deployment: DeploymentService,
  ) {}

  connection(userId: string) {
    const slug = this.config.get('auth.githubApp.slug', { infer: true });
    return {
      connected: this.connectionService.connected(userId),
      installation_url: slug
        ? `https://github.com/apps/${slug}/installations/new`
        : null,
    };
  }

  async installations(userId: string, query: GithubPageDto) {
    const result = await this.api<{
      total_count: number;
      installations: GithubInstallation[];
    }>(
      userId,
      `/user/installations?per_page=${query.per_page}&page=${query.page}`,
    );
    return {
      total_count: result.total_count,
      page: query.page,
      installations: result.installations.map((item) => ({
        id: item.id,
        account: item.account.login,
      })),
    };
  }

  async repositories(userId: string, query: GithubRepositoriesQueryDto) {
    const result = await this.api<GithubRepositories>(
      userId,
      `/user/installations/${query.installation_id}/repositories?per_page=${query.per_page}&page=${query.page}`,
    );
    return {
      total_count: result.total_count,
      page: query.page,
      repositories: result.repositories.map((repo) =>
        this.repositoryView(repo),
      ),
    };
  }

  async branches(
    userId: string,
    repositoryId: number,
    query: GithubRepositoriesQueryDto,
  ) {
    const repo = await this.authorizedRepository(
      userId,
      query.installation_id,
      repositoryId,
    );
    const branches = await this.api<GithubBranchResponseDto[]>(
      userId,
      `/repos/${repo.full_name}/branches?per_page=${query.per_page}&page=${query.page}`,
    );
    return {
      repository_id: repo.id,
      default_branch: repo.default_branch,
      page: query.page,
      branches: branches.map((item) => ({ name: item.name })),
    };
  }

  async commits(
    userId: string,
    applicationId: string,
    query: GithubCommitsQueryDto,
  ) {
    const link = this.database.db
      .select()
      .from(githubApplicationLinks)
      .where(
        and(
          eq(githubApplicationLinks.applicationId, applicationId),
          eq(githubApplicationLinks.userId, userId),
        ),
      )
      .get();
    if (!link) throw new NotFoundException('Linked application not found');
    const repo = await this.authorizedRepository(
      userId,
      link.installationId,
      link.repositoryId,
    );
    const commits = query.revision
      ? [
          await this.api<GithubCommitResponse>(
            userId,
            `/repos/${repo.full_name}/commits/${query.revision}`,
          ),
        ]
      : await this.api<GithubCommitResponse[]>(
          userId,
          `/repos/${repo.full_name}/commits?sha=${encodeURIComponent(link.branch)}&per_page=${query.per_page}&page=${query.page}`,
        );
    return {
      branch: link.branch,
      page: query.page,
      hasMore: !query.revision && commits.length === query.per_page,
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author?.name ?? '',
        date: c.commit.author?.date ?? null,
        url: c.html_url,
      })),
    };
  }

  async createApplication(userId: string, input: GithubApplicationDto) {
    const repo = await this.authorizedRepository(
      userId,
      input.installation_id,
      input.repository_id,
    );
    const sourceRevision = await this.requireBranch(
      userId,
      repo.full_name,
      input.branch,
    );
    try {
      return this.database.db.transaction(() => {
        const view = this.applicationsService.create({
          name: input.name,
          slug: input.slug,
          image_repo: input.image_repo,
          container_port: input.container_port,
          test_template: input.test_template,
          requires_approval: input.requires_approval,
          health_check: input.health_check,
          environment: input.environment,
          test_environment: input.test_environment,
          repo: repo.full_name,
          default_branch: input.branch,
          source_path:
            input.source_path === 'github'
              ? `https://github.com/${repo.full_name}.git`
              : input.source_path,
        });
        const github = {
          applicationId: view.application.id,
          userId,
          installationId: input.installation_id,
          repositoryId: repo.id,
          repositoryFullName: repo.full_name,
          branch: input.branch,
          autoDeploy: input.auto_deploy,
          active: true,
          createdAt: new Date().toISOString(),
        };
        this.database.db.insert(githubApplicationLinks).values(github).run();
        const initialDeployment = this.deployment.create(
          view.application.id,
          { source_revision: sourceRevision },
          userId,
          'registration',
        );
        return {
          ...view,
          github,
          initial_deployment: initialDeployment,
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint'))
        throw new ConflictException('Application slug already exists');
      throw error;
    }
  }

  async updateBranch(
    userId: string,
    applicationId: string,
    input: GithubBranchDto,
  ) {
    const link = this.database.db
      .select()
      .from(githubApplicationLinks)
      .where(
        and(
          eq(githubApplicationLinks.applicationId, applicationId),
          eq(githubApplicationLinks.userId, userId),
        ),
      )
      .get();
    if (!link) throw new NotFoundException('Linked application not found');
    const repo = await this.authorizedRepository(
      userId,
      link.installationId,
      link.repositoryId,
    );
    await this.requireBranch(userId, repo.full_name, input.branch);
    this.database.db.transaction((tx) => {
      tx.update(githubApplicationLinks)
        .set({
          branch: input.branch,
          autoDeploy: input.auto_deploy ?? link.autoDeploy,
          active: true,
          repositoryFullName: repo.full_name,
        })
        .where(eq(githubApplicationLinks.applicationId, applicationId))
        .run();
      tx.update(applications)
        .set({
          defaultBranch: input.branch,
          repo: repo.full_name,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(applications.id, applicationId))
        .run();
    });
    return this.database.db
      .select()
      .from(githubApplicationLinks)
      .where(eq(githubApplicationLinks.applicationId, applicationId))
      .get();
  }

  webhook(
    raw: Buffer | undefined,
    signature: string | undefined,
    delivery: string | undefined,
    event: string | undefined,
  ) {
    const secret = this.config.get('auth.githubApp.webhookSecret', {
      infer: true,
    });
    if (!secret)
      throw new ServiceUnavailableException(
        'GitHub webhook secret is not configured',
      );
    if (!raw || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
      throw new UnauthorizedException(
        'Webhook signature is missing or malformed',
      );
    const expected = createHmac('sha256', secret).update(raw).digest();
    const received = Buffer.from(signature.slice(7), 'hex');
    if (!timingSafeEqual(expected, received))
      throw new UnauthorizedException('Invalid webhook signature');
    if (
      !delivery ||
      !isUUID(delivery, 'all') ||
      !event ||
      !/^[a-z_]{1,64}$/.test(event)
    )
      throw new BadRequestException('Invalid webhook headers');
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Expected object');
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Invalid webhook JSON');
    }
    const hash = createHash('sha256').update(raw).digest('hex');
    return this.database.db.transaction((tx) => {
      const previous = tx
        .select()
        .from(githubWebhookDeliveries)
        .where(eq(githubWebhookDeliveries.id, delivery))
        .get();
      if (previous) {
        if (previous.payloadHash !== hash || previous.event !== event)
          throw new ConflictException(
            'Delivery ID was already used for a different payload',
          );
        return {
          duplicate: true,
          status: previous.status,
          deployment_ids: previous.deploymentIds,
        };
      }
      const samePayload = tx
        .select()
        .from(githubWebhookDeliveries)
        .where(
          and(
            eq(githubWebhookDeliveries.event, event),
            eq(githubWebhookDeliveries.payloadHash, hash),
          ),
        )
        .get();
      if (samePayload) {
        tx.insert(githubWebhookDeliveries)
          .values({
            ...samePayload,
            id: delivery,
            receivedAt: new Date().toISOString(),
          })
          .run();
        return {
          duplicate: true,
          status: samePayload.status,
          deployment_ids: samePayload.deploymentIds,
        };
      }
      const ids: string[] = [];
      if (event === 'push') {
        const push = plainToInstance(GithubPushDto, payload);
        if (validateSync(push).length || !push.repository || !push.installation)
          throw new BadRequestException('Invalid push payload');
        if (
          !push.deleted &&
          push.ref.startsWith('refs/heads/') &&
          push.after !== '0'.repeat(40)
        ) {
          const links = tx
            .select()
            .from(githubApplicationLinks)
            .where(
              and(
                eq(githubApplicationLinks.installationId, push.installation.id),
                eq(githubApplicationLinks.repositoryId, push.repository.id),
                eq(
                  githubApplicationLinks.branch,
                  push.ref.slice('refs/heads/'.length),
                ),
                eq(githubApplicationLinks.autoDeploy, true),
                eq(githubApplicationLinks.active, true),
              ),
            )
            .all();
          for (const link of links)
            ids.push(
              this.deployment.create(
                link.applicationId,
                { source_revision: push.after },
                link.userId,
                'webhook',
              ).id,
            );
        }
      } else if (
        event === 'installation' &&
        ['deleted', 'suspend'].includes(String(payload.action))
      ) {
        const installation = plainToInstance(GithubIdDto, payload.installation);
        if (!installation || validateSync(installation).length)
          throw new BadRequestException('Invalid installation payload');
        tx.update(githubApplicationLinks)
          .set({ active: false })
          .where(eq(githubApplicationLinks.installationId, installation.id))
          .run();
      } else if (
        event === 'installation_repositories' &&
        payload.action === 'removed'
      ) {
        const installation = plainToInstance(GithubIdDto, payload.installation);
        if (
          !installation ||
          validateSync(installation).length ||
          !Array.isArray(payload.repositories_removed)
        )
          throw new BadRequestException('Invalid installation payload');
        for (const item of payload.repositories_removed) {
          const repo = plainToInstance(GithubIdDto, item);
          if (!repo || validateSync(repo).length)
            throw new BadRequestException('Invalid repository payload');
          tx.update(githubApplicationLinks)
            .set({ active: false })
            .where(
              and(
                eq(githubApplicationLinks.installationId, installation.id),
                eq(githubApplicationLinks.repositoryId, repo.id),
              ),
            )
            .run();
        }
      } else if (
        event === 'github_app_authorization' &&
        payload.action === 'revoked'
      ) {
        const sender = plainToInstance(GithubIdDto, payload.sender);
        if (!sender || validateSync(sender).length)
          throw new BadRequestException('Invalid sender payload');
        const user = tx
          .select()
          .from(users)
          .where(eq(users.githubId, String(sender.id)))
          .get();
        if (user) {
          tx.delete(githubCredentials)
            .where(eq(githubCredentials.userId, user.id))
            .run();
          tx.update(githubApplicationLinks)
            .set({ active: false })
            .where(eq(githubApplicationLinks.userId, user.id))
            .run();
        }
      }
      const status = ids.length ? ('processed' as const) : ('ignored' as const);
      tx.insert(githubWebhookDeliveries)
        .values({
          id: delivery,
          event,
          payloadHash: hash,
          status,
          deploymentIds: ids,
          receivedAt: new Date().toISOString(),
        })
        .run();
      return { duplicate: false, status, deployment_ids: ids };
    });
  }

  private repositoryView(repo: GithubRepository) {
    const parsed = plainToInstance(GithubRepositoryDto, repo);
    if (validateSync(parsed).length)
      throw new BadGatewayException('Invalid GitHub repository response');
    return {
      id: parsed.id,
      full_name: parsed.full_name,
      default_branch: parsed.default_branch,
      private: parsed.private,
    };
  }

  private async authorizedRepository(
    userId: string,
    installationId: number,
    repositoryId: number,
  ) {
    for (let page = 1; page <= 100; page++) {
      const result = await this.api<GithubRepositories>(
        userId,
        `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      );
      const repo = result.repositories.find((item) => item.id === repositoryId);
      if (repo) return this.repositoryView(repo);
      if (page * 100 >= result.total_count || result.repositories.length < 100)
        break;
    }
    throw new NotFoundException('Repository is not accessible');
  }

  private async requireBranch(userId: string, repo: string, branch: string) {
    const found = await this.api<GithubBranchResponseDto>(
      userId,
      `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
    );
    if (
      found.name !== branch ||
      !/^[a-f0-9]{40}$/.test(found.commit?.sha ?? '')
    )
      throw new BadGatewayException('GitHub branch response does not match');
    return found.commit.sha;
  }

  private async api<T>(userId: string, path: string): Promise<T> {
    const token = await this.connectionService.accessToken(userId);
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'hibiscus-backend',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401)
        throw new UnauthorizedException('GitHub login is required');
      if (response.status === 404 || response.status === 403)
        throw new NotFoundException('GitHub resource is not accessible');
      if (!response.ok)
        throw new BadGatewayException('GitHub API request failed');
      return (await response.json()) as T;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof NotFoundException ||
        error instanceof BadGatewayException
      )
        throw error;
      throw new BadGatewayException('Cannot connect to GitHub');
    }
  }
}
