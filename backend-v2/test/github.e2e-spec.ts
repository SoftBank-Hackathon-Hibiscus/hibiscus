import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { AuthService } from '../src/auth/auth.service.js';
import { UserService } from '../src/user/user.service.js';
import { GithubConnectionService } from '../src/github/github-connection.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { DeploymentService } from '../src/deployment/deployment.service.js';
import {
  applications,
  deployments,
  githubApplicationLinks,
  githubCredentials,
  githubWebhookDeliveries,
} from '../src/database/schema.js';

describe('GitHub management and Webhook (e2e)', () => {
  let app: INestApplication;
  let directory: string;
  let database: DatabaseService;
  let connection: GithubConnectionService;
  let userId: string;
  let accessToken: string;
  let otherAccessToken: string;
  let repoSequence = 200;
  const webhookSecret = randomBytes(32).toString('hex');
  const providerToken = 'ghu_private_provider_token';

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'hibiscus-github-e2e-'));
    Object.assign(process.env, {
      DATABASE_FILE: join(directory, 'test.db'),
      CLI_TEMP_DIR: join(directory, 'cli'),
      JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      GITHUB_APP_CLIENT_ID: 'Iv1.test',
      GITHUB_APP_CLIENT_SECRET: 'test-secret',
      ALLOWED_GITHUB_IDS: '400000,400001',
      GITHUB_APP_SLUG: 'hibiscus-test',
      GITHUB_WEBHOOK_SECRET: webhookSecret,
      GITHUB_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      STAGE_MODE: 'skeleton',
      DEPLOY_MODE: 'off',
      HEALTH_MONITOR_ENABLED: 'false',
      GATEWAY_BASE_DOMAIN: 'apps.test',
      SSH_SERVER_ENABLED: 'false',
      SSH_HOST: '127.0.0.1',
      SSH_HOST_KEY_FILE: join(directory, 'ssh-host-key'),
    });
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    database = app.get(DatabaseService);
    connection = app.get(GithubConnectionService);
    const users = app.get(UserService);
    const user = users.upsertGithub({ id: 400000, login: 'github-owner' });
    const other = users.upsertGithub({ id: 400001, login: 'other' });
    userId = user.id;
    accessToken = (await app.get(AuthService).issueTokens(user)).access_token;
    otherAccessToken = (await app.get(AuthService).issueTokens(other))
      .access_token;
    connection.save(userId, {
      access_token: providerToken,
      token_type: 'bearer',
      expires_in: 28800,
      refresh_token: 'ghr_private_refresh_token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requires JWT and encrypts provider credentials at rest', async () => {
    await request(app.getHttpServer())
      .get('/github/repositories?installation_id=10')
      .expect(401);
    const row = database.db
      .select()
      .from(githubCredentials)
      .where(eq(githubCredentials.userId, userId))
      .get()!;
    expect(row.encryptedToken).not.toContain(providerToken);
    expect(row.encryptedToken).not.toContain('ghr_private_refresh_token');
    expect(await connection.accessToken(userId)).toBe(providerToken);
    const result = await request(app.getHttpServer())
      .get('/github/connection')
      .set('Authorization', bearer())
      .expect(200);
    expect(result.body).toEqual({
      connected: true,
      installation_url:
        'https://github.com/apps/hibiscus-test/installations/new',
    });
  });

  it('lists only installation-accessible repositories with pagination and branches', async () => {
    const repo = repository(100);
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          total_count: 1,
          installations: [{ id: 10, account: { login: 'octo' } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ total_count: 1, repositories: [repo] }),
      )
      .mockResolvedValueOnce(
        Response.json({ total_count: 1, repositories: [repo] }),
      )
      .mockResolvedValueOnce(
        Response.json([{ name: 'main' }, { name: 'feature/test' }]),
      );
    vi.stubGlobal('fetch', mock);
    await request(app.getHttpServer())
      .get('/github/installations')
      .set('Authorization', bearer())
      .expect(200)
      .expect((r) =>
        expect(r.body.installations).toEqual([{ id: 10, account: 'octo' }]),
      );
    const listed = await request(app.getHttpServer())
      .get('/github/repositories?installation_id=10&page=2&per_page=10')
      .set('Authorization', bearer())
      .expect(200);
    expect(listed.body.repositories).toEqual([repo]);
    expect(mock.mock.calls[1]![0]).toContain('per_page=10&page=2');
    const branches = await request(app.getHttpServer())
      .get('/github/repositories/100/branches?installation_id=10')
      .set('Authorization', bearer())
      .expect(200);
    expect(branches.body.branches).toEqual([
      { name: 'main' },
      { name: 'feature/test' },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(providerToken);
  });

  it('refreshes an expired GitHub token and stores its replacement encrypted', async () => {
    connection.save(userId, {
      access_token: 'ghu_expired',
      token_type: 'bearer',
      expires_in: -1,
      refresh_token: 'ghr_old',
    });
    const mock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'ghu_renewed',
        token_type: 'bearer',
        expires_in: 28800,
        refresh_token: 'ghr_new',
      }),
    );
    vi.stubGlobal('fetch', mock);
    const tokens = await Promise.all([
      connection.accessToken(userId),
      connection.accessToken(userId),
    ]);
    expect(tokens).toEqual(['ghu_renewed', 'ghu_renewed']);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(
      (mock.mock.calls[0]![1].body as URLSearchParams).get('grant_type'),
    ).toBe('refresh_token');
    connection.save(userId, {
      access_token: providerToken,
      token_type: 'bearer',
      expires_in: 28800,
    });
  });

  it('checks repository access and branch existence before creating an application', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ total_count: 0, repositories: [] })),
    );
    await request(app.getHttpServer())
      .post('/github/applications')
      .set('Authorization', bearer())
      .send(applicationInput(999, 'missing'))
      .expect(404);
    expect(database.db.select().from(applications).all()).toHaveLength(0);
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ total_count: 1, repositories: [repository(999)] }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 404 }));
    vi.stubGlobal('fetch', mock);
    await request(app.getHttpServer())
      .post('/github/applications')
      .set('Authorization', bearer())
      .send(applicationInput(999, 'missing'))
      .expect(404);
    expect(database.db.select().from(applications).all()).toHaveLength(0);
  });

  it('creates from a repository and lets only its owner change the branch', async () => {
    const created = await createApplication();
    expect(created.application.repo).toBe(
      `octo/repo-${created.github.repositoryId}`,
    );
    expect(created.application.defaultBranch).toBe('main');
    expect(created.application.sourcePath).toBe(
      `https://github.com/octo/repo-${created.github.repositoryId}.git`,
    );
    await request(app.getHttpServer())
      .patch(`/github/applications/${created.application.id}/branch`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .send({ branch: 'feature/test' })
      .expect(404);
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          total_count: 1,
          repositories: [repository(created.github.repositoryId)],
        }),
      )
      .mockResolvedValueOnce(Response.json({ name: 'feature/test' }));
    vi.stubGlobal('fetch', mock);
    await request(app.getHttpServer())
      .patch(`/github/applications/${created.application.id}/branch`)
      .set('Authorization', bearer())
      .send({ branch: 'feature/test', auto_deploy: false })
      .expect(200);
    expect(mock.mock.calls[1]![0]).toContain('/branches/feature%2Ftest');
    expect(
      database.db
        .select()
        .from(applications)
        .where(eq(applications.id, created.application.id))
        .get()?.defaultBranch,
    ).toBe('feature/test');
  });

  it('validates HMAC over exact raw bytes before recording or creating a deployment', async () => {
    const created = await createApplication();
    const payload = push(created.github.repositoryId);
    const raw = JSON.stringify(payload, null, 2);
    await request(app.getHttpServer())
      .post('/github/webhooks')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Delivery', randomUUID())
      .set('X-GitHub-Event', 'push')
      .send(raw)
      .expect(401);
    await deliver(raw, randomUUID(), 'push', `sha256=${'0'.repeat(64)}`).expect(
      401,
    );
    expect(
      database.db.select().from(githubWebhookDeliveries).all(),
    ).toHaveLength(0);
    const result = await deliver(raw).expect(200);
    expect(result.body.deployment_ids).toHaveLength(1);
    const row = database.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, result.body.deployment_ids[0]))
      .get()!;
    expect(row).toMatchObject({
      requester: userId,
      sourceRevision: payload.after,
      sourceRevisionVerified: false,
      trigger: 'webhook',
    });
  });

  it('persists delivery deduplication and rejects reused IDs with changed content', async () => {
    const created = await createApplication();
    const raw = JSON.stringify(push(created.github.repositoryId));
    const delivery = randomUUID();
    const first = await deliver(raw, delivery).expect(200);
    const duplicate = await deliver(raw, delivery).expect(200);
    expect(duplicate.body).toMatchObject({
      duplicate: true,
      deployment_ids: first.body.deployment_ids,
    });
    const samePayload = await deliver(raw, randomUUID()).expect(200);
    expect(samePayload.body.duplicate).toBe(true);
    expect(
      database.db
        .select()
        .from(deployments)
        .where(eq(deployments.applicationId, created.application.id))
        .all(),
    ).toHaveLength(1);
    await deliver(
      JSON.stringify({
        ...push(created.github.repositoryId),
        after: 'b'.repeat(40),
      }),
      delivery,
    ).expect(409);
  });

  it('ignores unselected branches, tags, and branch deletions', async () => {
    const created = await createApplication();
    for (const variant of [
      { ref: 'refs/heads/other' },
      { ref: 'refs/tags/v1' },
      { deleted: true, after: '0'.repeat(40) },
    ]) {
      await deliver(
        JSON.stringify({ ...push(created.github.repositoryId), ...variant }),
      )
        .expect(200)
        .expect((r) => expect(r.body.deployment_ids).toEqual([]));
    }
    expect(
      database.db
        .select()
        .from(deployments)
        .where(eq(deployments.applicationId, created.application.id))
        .all(),
    ).toHaveLength(0);
  });

  it('rolls back the delivery marker on failure so the same delivery can be retried', async () => {
    const created = await createApplication();
    const raw = JSON.stringify(push(created.github.repositoryId));
    const id = randomUUID();
    const spy = vi
      .spyOn(app.get(DeploymentService), 'create')
      .mockImplementationOnce(() => {
        throw new Error('intentional transaction failure');
      });
    await deliver(raw, id).expect(500);
    expect(
      database.db
        .select()
        .from(githubWebhookDeliveries)
        .where(eq(githubWebhookDeliveries.id, id))
        .get(),
    ).toBeUndefined();
    spy.mockRestore();
    await deliver(raw, id)
      .expect(200)
      .expect((r) => expect(r.body.deployment_ids).toHaveLength(1));
  });

  it('disables auto-deploy after repository access is removed', async () => {
    const created = await createApplication();
    await deliver(
      JSON.stringify({
        action: 'removed',
        installation: { id: 10 },
        repositories_removed: [{ id: created.github.repositoryId }],
      }),
      randomUUID(),
      'installation_repositories',
    ).expect(200);
    expect(
      database.db
        .select()
        .from(githubApplicationLinks)
        .where(eq(githubApplicationLinks.applicationId, created.application.id))
        .get()?.active,
    ).toBe(false);
    await deliver(JSON.stringify(push(created.github.repositoryId)))
      .expect(200)
      .expect((r) => expect(r.body.deployment_ids).toEqual([]));
  });

  it('supports the GitHub ping event without a JWT', async () => {
    await deliver(JSON.stringify({ zen: 'test' }), randomUUID(), 'ping')
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('ignored'));
  });

  function bearer() {
    return `Bearer ${accessToken}`;
  }
  function repository(id: number) {
    return {
      id,
      full_name: `octo/repo-${id}`,
      default_branch: 'main',
      private: true,
    };
  }
  function applicationInput(id: number, branch = 'main') {
    return {
      installation_id: 10,
      repository_id: id,
      branch,
      name: `Repo ${id}`,
      slug: `repo-${id}`,
      image_repo: `registry.example/repo-${id}`,
    };
  }
  async function createApplication() {
    const id = ++repoSequence;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ total_count: 1, repositories: [repository(id)] }),
        )
        .mockResolvedValueOnce(Response.json({ name: 'main' })),
    );
    const response = await request(app.getHttpServer())
      .post('/github/applications')
      .set('Authorization', bearer())
      .send(applicationInput(id))
      .expect(201);
    vi.unstubAllGlobals();
    return response.body;
  }
  function push(repositoryId: number) {
    return {
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      deleted: false,
      installation: { id: 10 },
      repository: { id: repositoryId },
    };
  }
  function deliver(
    raw: string,
    id = randomUUID(),
    event = 'push',
    signature = `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`,
  ) {
    return request(app.getHttpServer())
      .post('/github/webhooks')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .set('X-GitHub-Delivery', id)
      .set('X-GitHub-Event', event)
      .send(raw);
  }

  afterAll(async () => {
    if (app) await app.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    for (const key of [
      'DATABASE_FILE',
      'CLI_TEMP_DIR',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'ALLOWED_GITHUB_IDS',
      'GITHUB_APP_SLUG',
      'GITHUB_WEBHOOK_SECRET',
      'GITHUB_TOKEN_ENCRYPTION_KEY',
      'STAGE_MODE',
      'DEPLOY_MODE',
      'HEALTH_MONITOR_ENABLED',
      'GATEWAY_BASE_DOMAIN',
      'SSH_SERVER_ENABLED',
      'SSH_HOST',
      'SSH_HOST_KEY_FILE',
    ])
      delete process.env[key];
  });
});
