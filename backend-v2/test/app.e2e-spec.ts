import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DeploymentRepository } from '../src/deployment/deployment.repository.js';
import { ContractValidator } from './helpers/contract-validator.js';
import {
  canonicalJson,
  DeploymentPaths,
} from '../src/deployment/types/deployment.type.js';
import { DeploymentArtifactService } from '../src/deployment/deployment-artifact.service.js';
import { PolicyStage } from '../src/deployment/stages/policy.stage.js';
import { CommandRunner } from '../src/infrastructure/command-runner.js';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { AuthConfig } from '../src/config/configs/auth.config.js';
import { AuthService } from '../src/auth/auth.service.js';
import { UserService } from '../src/user/user.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AgentRepository } from '../src/agent/agent.repository.js';
import { agentJobs, agents } from '../src/database/schema.js';
import { eq } from 'drizzle-orm';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { RoutingService } from '../src/routing/routing.service.js';
import { FailoverService } from '../src/health/failover.service.js';
import ssh2 from 'ssh2';

const { Client: SshClient, utils: sshUtils } = ssh2;

describe('deployment API (e2e)', () => {
  let app: INestApplication<App>;
  let testDirectory: string;
  let auth: AuthService;
  let users: UserService;
  let defaultToken: string;
  const identities = new Map<string, { id: string; access_token: string }>();

  beforeAll(async () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'backend-v2-'));
    process.env.DATABASE_FILE = join(testDirectory, 'test.db');
    process.env.WORKER_POLL_MS = '50';
    process.env.CLI_TEMP_DIR = join(testDirectory, 'cli');
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test-client';
    process.env.GITHUB_APP_CLIENT_SECRET = 'test-client-secret';
    process.env.HEALTH_MONITOR_ENABLED = 'false';
    process.env.GATEWAY_BASE_DOMAIN = 'apps.test';
    process.env.SSH_SERVER_ENABLED = 'true';
    process.env.SSH_BIND_HOST = '127.0.0.1';
    process.env.SSH_HOST = '127.0.0.1';
    process.env.SSH_PORT = '0';
    process.env.SSH_HOST_KEY_FILE = join(testDirectory, 'ssh-host-key');
    process.env.ALLOWED_GITHUB_IDS = [
      ...Array.from({ length: 32 }, (_, index) => String(index + 1)),
      '1000000',
    ].join(',');

    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    auth = app.get(AuthService);
    users = app.get(UserService);
    defaultToken = (await identity('tester')).access_token;
  });

  it('returns health state', async () => {
    await api().get('/healthz').expect(200, { ok: true });
  });

  it('returns English API errors', async () => {
    const missing = await api().get('/applications/missing').expect(404);
    expect(missing.body.message).toBe('Application not found');
    const unauthorized = await request(app.getHttpServer())
      .get('/users/me')
      .expect(401);
    expect(unauthorized.body.message).toBe('Bearer access token is required');
    const providerFailure = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('외부 서비스 연결 실패'));
    try {
      const start = await request(app.getHttpServer())
        .get('/auth/github')
        .expect(200);
      const url = new URL(start.body.authorization_url);
      const failure = await request(app.getHttpServer())
        .get('/auth/github/callback')
        .set('Cookie', start.headers['set-cookie'][0].split(';')[0])
        .query({ code: 'test-code', state: url.searchParams.get('state') })
        .expect(502);
      expect(failure.body.message).toBe('Unable to connect to GitHub');
    } finally {
      providerFailure.mockRestore();
    }
  });

  it('protects management APIs and returns the authenticated user identifier', async () => {
    for (const path of [
      '/users/me',
      '/applications',
      '/agents',
      '/deployments/unknown',
    ]) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
    const response = await api().get('/users/me').expect(200);
    expect(response.body).toMatchObject({
      id: (await identity('tester')).id,
      login: 'tester',
    });
    expect(response.body).not.toHaveProperty('access_token');
  });

  it('separates access and refresh JWTs and rejects expired or modified tokens', async () => {
    const user = users.find((await identity('tester')).id)!;
    const tokens = await auth.issueTokens(user);
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${tokens.refresh_token}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: tokens.access_token })
      .expect(401);
    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: tokens.refresh_token })
      .expect(201);
    expect(refreshed.headers['cache-control']).toBe('no-store');
    expect(refreshed.body.user.id).toBe(user.id);
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${refreshed.body.access_token}`)
      .expect(200);
    const parts = tokens.access_token.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ sub: (await identity('reviewer')).id, kind: 'access' }),
    ).toString('base64url');
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${parts.join('.')}`)
      .expect(401);
    const settings = app
      .get(ConfigService<AuthConfig, true>)
      .get('auth.jwt', { infer: true });
    const expired = new JwtService().sign(
      { sub: user.id, kind: 'access' },
      {
        secret: settings.accessSecret,
        algorithm: 'HS256',
        issuer: settings.issuer,
        audience: 'hibiscus-access',
        expiresIn: -1,
      },
    );
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
    const expiredRefresh = new JwtService().sign(
      { sub: user.id, kind: 'refresh' },
      {
        secret: settings.refreshSecret,
        algorithm: 'HS256',
        issuer: settings.issuer,
        audience: 'hibiscus-refresh',
        expiresIn: -1,
      },
    );
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: expiredRefresh })
      .expect(401);
  });

  it('uses PKCE, returns a JSON callback, and keeps the identifier after a GitHub rename', async () => {
    const first = await githubLogin('github-person');
    expect(first.headers['content-type']).toContain('application/json');
    expect(first.headers.location).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.user).toMatchObject({
      githubId: '1000000',
      login: 'github-person',
    });
    expect(first.body).not.toHaveProperty('cookie');
    expect(first.body).not.toHaveProperty('verifier');
    const second = await githubLogin('renamed-person');
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.user.createdAt).toBe(first.body.user.createdAt);
    expect(second.body.user.login).toBe('renamed-person');
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${first.body.access_token}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.login).toBe('renamed-person');
      });
  });

  it('rejects a GitHub user outside the configured allowlist', async () => {
    const response = await githubLogin(
      'outside-user',
      'Outside User',
      9_999_999,
      403,
    );
    expect(response.body.message).toBe('GitHub user is not allowed');
    expect(response.body).not.toHaveProperty('access_token');
  });

  it('rejects missing, wrong, modified, and expired OAuth state before contacting GitHub', async () => {
    const start = await request(app.getHttpServer())
      .get('/auth/github')
      .expect(200);
    const url = new URL(start.body.authorization_url);
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const query = { code: 'test-code', state: url.searchParams.get('state')! };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await request(app.getHttpServer())
        .get('/auth/github/callback')
        .query(query)
        .expect(401);
      await request(app.getHttpServer())
        .get('/auth/github/callback')
        .set('Cookie', cookie)
        .query({ ...query, state: 'x'.repeat(43) })
        .expect(401);
      await request(app.getHttpServer())
        .get('/auth/github/callback')
        .set('Cookie', `${cookie}x`)
        .query(query)
        .expect(401);
      const settings = app
        .get(ConfigService<AuthConfig, true>)
        .get('auth.jwt', { infer: true });
      const expired = new JwtService().sign(
        { kind: 'oauth-state', state: query.state, verifier: 'v'.repeat(43) },
        {
          secret: settings.refreshSecret,
          algorithm: 'HS256',
          issuer: settings.issuer,
          audience: 'hibiscus-oauth-state',
          expiresIn: -1,
        },
      );
      await request(app.getHttpServer())
        .get('/auth/github/callback')
        .set('Cookie', `hibiscus_oauth=${expired}`)
        .query(query)
        .expect(401);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a provider code error and does not expose provider credentials', async () => {
    const start = await request(app.getHttpServer())
      .get('/auth/github')
      .expect(200);
    const state = new URL(start.body.authorization_url).searchParams.get(
      'state',
    );
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          error: 'bad_verification_code',
          error_description: 'provider-private-details',
        }),
      ),
    );
    try {
      const response = await request(app.getHttpServer())
        .get('/auth/github/callback')
        .set('Cookie', cookie)
        .query({ code: 'reused-code', state })
        .expect(401);
      expect(response.body).not.toHaveProperty('access_token');
      expect(JSON.stringify(response.body)).not.toContain(
        'provider-private-details',
      );
      expect(response.headers['set-cookie'][0]).toContain(
        'Expires=Thu, 01 Jan 1970',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects caller-supplied requester and approver identifiers', async () => {
    const application = await createApplication('identity-spoof', true);
    await api()
      .post(`/applications/${application.application.id}/deployments`)
      .send({ source_revision: '0123456789abcdef', requester: 'someone-else' })
      .expect(400);
    const deployment = await createDeployment(
      application.application.id,
      'tester',
    );
    expect(deployment.requester).toBe((await identity('tester')).id);
    await waitForStatus(deployment.id, 'awaiting_approval');
    await api()
      .post(`/deployments/${deployment.id}/approve`)
      .send({ approver: (await identity('reviewer')).id })
      .expect(400);
    await api()
      .post(`/deployments/${deployment.id}/approve`)
      .send({})
      .expect(403);
  });

  it('trusts typed GitHub profile fields without applying local field limits', async () => {
    const name = 'n'.repeat(300);
    const response = await githubLogin('trusted-provider', name);
    expect(response.body.user.name).toBe(name);
  });

  async function githubLogin(
    login: string,
    name = 'Person',
    githubId = 1_000_000,
    expectedStatus = 200,
  ) {
    const start = await request(app.getHttpServer())
      .get('/auth/github')
      .expect(200);
    const url = new URL(start.body.authorization_url);
    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('client_id')).toBe('Iv1.test-client');
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const rawCookie: string = start.headers['set-cookie'][0];
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('SameSite=Lax');
    expect(rawCookie).toContain('Path=/auth/github');
    const cookie = rawCookie.split(';')[0]!;
    const claims = new JwtService().decode<{ verifier: string }>(
      cookie.slice('hibiscus_oauth='.length),
    );
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(claims.verifier).digest('base64url'),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'ghu_provider_token',
          token_type: 'bearer',
          scope: '',
          expires_in: 28800,
          refresh_token: 'ghr_provider_refresh',
          refresh_token_expires_in: 15897600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: githubId,
          login,
          name,
          avatar_url: `https://avatars.githubusercontent.com/u/${githubId}`,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await request(app.getHttpServer())
        .get('/auth/github/callback')
        .set('Cookie', cookie)
        .query({
          code: 'test-code',
          state: url.searchParams.get('state'),
          iss: 'https://github.com/login/oauth',
        })
        .expect(expectedStatus);
      const exchange: RequestInit = fetchMock.mock.calls[0]![1];
      expect((exchange.body as URLSearchParams).get('client_id')).toBe(
        'Iv1.test-client',
      );
      expect((exchange.body as URLSearchParams).get('code_verifier')).toBe(
        claims.verifier,
      );
      expect(fetchMock.mock.calls[0]![0]).toBe(
        'https://github.com/login/oauth/access_token',
      );
      expect(fetchMock.mock.calls[1]![0]).toBe('https://api.github.com/user');
      expect(JSON.stringify(response.body)).not.toContain('ghu_provider_token');
      expect(JSON.stringify(response.body)).not.toContain(
        'ghr_provider_refresh',
      );
      const profileRequest: RequestInit = fetchMock.mock.calls[1]![1];
      expect(profileRequest.headers).toMatchObject({
        Authorization: 'Bearer ghu_provider_token',
      });
      expect(response.headers['set-cookie'][0]).toContain(
        'Expires=Thu, 01 Jan 1970',
      );
      return response;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('requires a valid source revision without inspecting local Git', async () => {
    const application = await createApplication('revision-contract', false);
    const endpoint = `/applications/${application.application.id}/deployments`;
    await api().post(endpoint).send({}).expect(400);
    await api().post(endpoint).send({ source_revision: 'invalid' }).expect(400);
    const deployment = await createDeployment(
      application.application.id,
      'tester',
    );
    expect(deployment.sourceRevision).toBe('0123456789abcdef');
    expect(deployment.sourceRevisionVerified).toBe(false);
  });

  it('rejects an invalid application request', async () => {
    await api().post('/applications').send({ name: '' }).expect(400);
  });

  it('rejects unknown DTO fields and invalid nested health values', async () => {
    const validApplication = {
      name: 'validation',
      slug: 'validation',
      source_path: './fixtures/validation',
      image_repo: 'registry.example/validation',
    };

    await api()
      .post('/applications')
      .send({ ...validApplication, unknown_field: true })
      .expect(400);

    await api()
      .post('/applications')
      .send({
        ...validApplication,
        health_check: {
          interval_seconds: 2,
          timeout_seconds: 3,
        },
      })
      .expect(400);

    await api()
      .post('/applications')
      .send({
        ...validApplication,
        health_check: { path: '//external.example/health' },
      })
      .expect(400);

    await api()
      .post('/applications')
      .send({
        ...validApplication,
        health_check: { version_path: 'https://external.example/version' },
      })
      .expect(400);
  });

  it('creates an application with configurable health checks', async () => {
    const application = await createApplication('health-config', false, {
      path: '/ready',
      version_path: '/version',
      interval_seconds: 10,
      timeout_seconds: 3,
      failure_threshold: 5,
    });

    expect(application.healthCheck).toMatchObject({
      applicationId: application.application.id,
      path: '/ready',
      versionPath: '/version',
      intervalSeconds: 10,
      timeoutSeconds: 3,
      successStatusMin: 200,
      successStatusMax: 399,
      failureThreshold: 5,
    });
    expect(application.application.containerPort).toBe(8080);
    expect(application.application.publicHost).toBe('health-config.apps.test');

    const response = await api()
      .patch(`/applications/${application.application.id}/health-check`)
      .send({ interval_seconds: 15, timeout_seconds: 4 })
      .expect(200);
    expect(response.body).toMatchObject({
      intervalSeconds: 15,
      timeoutSeconds: 4,
    });
  });

  it('assigns increasing deployment versions per application', async () => {
    const application = await createApplication('versions', false);
    const first = await createDeployment(
      application.application.id,
      'requester-a',
    );
    const second = await createDeployment(
      application.application.id,
      'requester-a',
      'b',
    );

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);

    const list = await api()
      .get(`/applications/${application.application.id}/deployments`)
      .expect(200);
    expect(
      list.body.map((deployment: { version: number }) => deployment.version),
    ).toEqual([2, 1]);
  });

  it('runs the MVP pipeline in order', async () => {
    const application = await createApplication('automatic', false);
    const deployment = await createDeployment(
      application.application.id,
      'requester-a',
    );
    const deploymentView = await waitForStatus(deployment.id, 'succeeded');

    expect(deploymentView.deployment.status).toBe('succeeded');
    expect(deploymentView.policyResult).toMatchObject({
      decision: 'allow',
      failoverAllowed: true,
    });
    expect(
      deploymentView.stages.map((stage: { stage: string }) => stage.stage),
    ).toEqual(['test', 'policy', 'sign', 'deploy']);
    expect(deploymentView.stages[3]).toMatchObject({
      stage: 'deploy',
      status: 'skipped',
    });
    expect(deploymentView.stages[0]).toMatchObject({
      attempt: 1,
      status: 'succeeded',
    });
    expect(deploymentView.stages[0].startedAt).toBeTruthy();
    expect(deploymentView.stages[0].finishedAt).toBeTruthy();
    expect(deploymentView.stages[0].artifacts).toHaveProperty('test_result');
    const artifacts: {
      id: string;
      name: string;
      content: string;
      contentHash: string;
      validationError: string | null;
    }[] = deploymentView.artifacts;
    const plan = artifacts.find((artifact) => artifact.name === 'plan')!;
    const signed = artifacts.find(
      (artifact) => artifact.name === 'sign_result',
    )!;
    expect(deploymentView.stages[1].artifacts.plan).toBe(plan.id);
    expect(deploymentView.policyResult.planArtifactId).toBe(plan.id);
    expect(deploymentView.policyResult.planPath).toBeNull();
    expect(plan.contentHash).toBe(
      createHash('sha256').update(plan.content).digest('hex'),
    );
    expect(
      artifacts.every((artifact) => artifact.validationError === null),
    ).toBe(true);
    const contracts = new ContractValidator();
    expect(
      contracts.violation(
        join(process.cwd(), '../contracts/Plan.schema.json'),
        JSON.parse(plan.content),
        'Plan',
      ),
    ).toBeUndefined();
    expect(
      contracts.violation(
        join(process.cwd(), '../contracts/SignResult.schema.json'),
        JSON.parse(signed.content),
        'SignResult',
      ),
    ).toBeUndefined();
    expect(JSON.parse(plan.content).targets).toEqual(['onprem', 'cloud_run']);
    expect(
      deploymentView.auditLogs.map((log: { kind: string }) => log.kind),
    ).toEqual(['deploy', 'sign']);
    expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
  });

  it('restores the saved Plan after server restart and preserves approval hashes', async () => {
    const application = await createApplication('restart-from-db', true);
    const deployment = await createDeployment(
      application.application.id,
      'tester',
    );
    const before = await waitForStatus(deployment.id, 'awaiting_approval');
    const savedPlan = before.artifacts.find(
      (artifact: { name: string }) => artifact.name === 'plan',
    );
    expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
    await app.close();
    const { AppModule } = await import('../src/app.module.js');
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = fixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    auth = app.get(AuthService);
    users = app.get(UserService);
    await api()
      .post(`/deployments/${deployment.id}/approve`)
      .set(
        'Authorization',
        `Bearer ${(await identity('reviewer')).access_token}`,
      )
      .send({})
      .expect(201);
    const after = await waitForStatus(deployment.id, 'succeeded');
    const plan = after.artifacts.find(
      (artifact: { name: string }) => artifact.name === 'plan',
    );
    const approval = JSON.parse(
      after.artifacts.find(
        (artifact: { name: string }) => artifact.name === 'approval',
      ).content,
    );
    const sign = JSON.parse(
      after.artifacts.find(
        (artifact: { name: string }) => artifact.name === 'sign_result',
      ).content,
    );
    expect(plan.content).toBe(savedPlan.content);
    expect(approval.plan_sha256).toBe(
      createHash('sha256')
        .update(canonicalJson(JSON.parse(plan.content)))
        .digest('hex'),
    );
    expect(sign.plan_hash).toBe(JSON.parse(savedPlan.content).plan_hash);
    expect(after.stages.map((stage: { stage: string }) => stage.stage)).toEqual(
      ['test', 'policy', 'sign', 'deploy'],
    );
    expect(after.auditLogs.map((log: { kind: string }) => log.kind)).toEqual([
      'deploy',
      'sign',
    ]);
    expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
    const repository = app.get(DeploymentRepository);
    const original = repository.listArtifacts(deployment.id);
    expect(() =>
      repository.checkpoint(
        [
          {
            ...original[0]!,
            id: randomUUID(),
            name: 'atomic-check',
            relativePath: 'test/atomic-check.json',
          },
        ],
        [],
        () => {
          repository.update(deployment.id, { status: 'failed' });
          throw new Error('checkpoint failure');
        },
      ),
    ).toThrow('checkpoint failure');
    expect(repository.listArtifacts(deployment.id)).toHaveLength(
      original.length,
    );
    expect(repository.find(deployment.id)!.status).toBe('succeeded');
    const scratch = new DeploymentPaths(
      join(testDirectory, 'cli'),
      deployment.id,
    );
    try {
      expect(() =>
        app
          .get(DeploymentArtifactService)
          .restore(scratch, [{ ...original[0]!, content: 'modified' }]),
      ).toThrow('Stored artifact content hash mismatch');
      expect(() =>
        app
          .get(DeploymentArtifactService)
          .restore(scratch, [
            { ...original[0]!, relativePath: '../outside.json' },
          ]),
      ).toThrow('Artifact path is outside the execution directory');
    } finally {
      scratch.cleanup();
    }
  });

  it('saves mismatched or unparseable outputs and does not advance the pipeline', async () => {
    const policy = vi
      .spyOn(app.get(PolicyStage), 'run')
      .mockImplementationOnce(async ({ paths }) => {
        writeFileSync(
          join(paths.policy, 'plan.json'),
          '{"invalid":true}\n',
          'utf8',
        );
        writeFileSync(paths.decisionsLog, 'not-json\n', 'utf8');
        return { status: 'succeeded', exitCode: 0, artifacts: {} };
      });
    try {
      const application = await createApplication('invalid-output', false);
      const deployment = await createDeployment(
        application.application.id,
        'tester',
      );
      const view = await waitForStatus(deployment.id, 'failed');
      expect(view.policyResult).toBeNull();
      expect(
        view.stages.map((stage: { stage: string }) => stage.stage),
      ).toEqual(['test', 'policy']);
      const plan = view.artifacts.find(
        (artifact: { name: string }) => artifact.name === 'plan',
      );
      const audit = view.artifacts.find(
        (artifact: { name: string }) => artifact.name === 'audit_log',
      );
      expect(plan.content).toBe('{"invalid":true}\n');
      expect(plan.validationError).toBeTruthy();
      expect(audit.content).toBe('not-json\n');
      expect(audit.validationError).toBeTruthy();
      expect(view.auditLogs).toEqual([]);
      expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
    } finally {
      policy.mockRestore();
    }
  });

  it('accepts producer metadata without revalidating the complete artifact schema', async () => {
    const application = await createApplication('trusted-contract', false);
    const deployment = await createDeployment(
      application.application.id,
      'tester',
    );
    await waitForStatus(deployment.id, 'succeeded');
    const view = app.get(DeploymentRepository).getView(deployment.id)!;
    const stage = view.stages.find(
      (execution) => execution.stage === 'policy',
    )!;
    const original = view.artifacts.find(
      (artifact) => artifact.name === 'plan',
    )!;
    const scratch = new DeploymentPaths(
      join(testDirectory, 'cli'),
      deployment.id,
    );
    scratch.ensure();
    try {
      const content = JSON.stringify({
        ...JSON.parse(original.content),
        producer_metadata: { version: 2 },
      });
      writeFileSync(join(scratch.policy, 'plan.json'), content, 'utf8');
      const captured = app
        .get(DeploymentArtifactService)
        .capture(scratch, stage, view.deployment);
      expect(captured.error).toBeUndefined();
      expect(captured.artifacts[0]!.content).toBe(content);
      expect(captured.artifacts[0]!.validationError).toBeNull();
      writeFileSync(
        join(scratch.policy, 'plan.json'),
        JSON.stringify({
          ...JSON.parse(content),
          digest: `sha256:${'b'.repeat(64)}`,
        }),
        'utf8',
      );
      expect(
        app
          .get(DeploymentArtifactService)
          .capture(scratch, stage, view.deployment).error,
      ).toBe('plan does not match the current deployment');
    } finally {
      scratch.cleanup();
    }
  });

  it('stores an English CLI error and preserves provider diagnostics separately', async () => {
    const config = app.get(ConfigService);
    const previousMode = config.get('backend.stageMode');
    config.set('backend.stageMode', 'cli');
    const runner = vi
      .spyOn(app.get(CommandRunner), 'run')
      .mockResolvedValueOnce({
        code: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '정책 실행 실패',
      });
    try {
      const application = await createApplication('cli-error', false);
      const deployment = await createDeployment(
        application.application.id,
        'tester',
      );
      const view = await waitForStatus(deployment.id, 'failed');
      expect(view.deployment.error).toBe(
        '[policy] Policy CLI failed with exit code 1',
      );
      expect(view.stages[1].error).not.toMatch(/[가-힣]/);
      expect(view.stages[1].summary.stderr).toBe('정책 실행 실패');
    } finally {
      runner.mockRestore();
      config.set('backend.stageMode', previousMode);
    }
  });

  it('returns an English stage error for unexpected failures', async () => {
    const policy = vi
      .spyOn(app.get(PolicyStage), 'run')
      .mockRejectedValueOnce(new Error('예상하지 못한 내부 오류'));
    try {
      const application = await createApplication('unexpected-error', false);
      const deployment = await createDeployment(
        application.application.id,
        'tester',
      );
      const view = await waitForStatus(deployment.id, 'failed');
      expect(view.deployment.error).toBe('[policy] Stage execution failed');
      expect(view.stages[1].error).toBe('Stage execution failed');
      expect(view.stages[1].summary.details).toBe('예상하지 못한 내부 오류');
    } finally {
      policy.mockRestore();
    }
  });

  it.skipIf(
    !existsSync('../policy/node_modules') ||
      !existsSync('../signer/node_modules'),
  )(
    'stores actual policy CLI and dry-run signer outputs in DB',
    async () => {
      const config = app.get(ConfigService);
      const previousMode = config.get('backend.stageMode');
      config.set('backend.stageMode', 'cli');
      try {
        const source = join(testDirectory, 'cli-source');
        mkdirSync(source);
        const response = await api()
          .post('/applications')
          .send({
            name: 'actual-cli',
            slug: 'actual-cli',
            source_path: source,
            image_repo: 'registry.example/actual-cli',
            test_template: 'allow',
            requires_approval: false,
            health_check: {},
          })
          .expect(201);
        const deployment = await createDeployment(
          response.body.application.id,
          'tester',
        );
        const view = await waitForStatus(deployment.id, 'succeeded', 20_000);
        expect(view.deployment.executionMode).toBe('cli');
        expect(view.deployment.deploymentPerformed).toBe(false);
        expect(
          view.artifacts.every(
            (artifact: { validationError: string | null }) =>
              artifact.validationError === null,
          ),
        ).toBe(true);
        expect(
          view.artifacts.map((artifact: { name: string }) => artifact.name),
        ).toEqual(
          expect.arrayContaining([
            'test_result',
            'plan',
            'pii',
            'explain.ko',
            'explain.ja',
            'sign_result',
            'audit_log',
          ]),
        );
        expect(view.policyResult.piiArtifactId).toBeTruthy();
        const signed = JSON.parse(
          view.artifacts.find(
            (artifact: { name: string }) => artifact.name === 'sign_result',
          ).content,
        );
        expect(signed.signature_ref).toMatch(/^dry-run:/);
        expect(view.auditLogs.map((log: { kind: string }) => log.kind)).toEqual(
          ['deploy', 'sign'],
        );
        expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
        const protectedApp = await api()
          .post('/applications')
          .send({
            name: 'actual-cli-approval',
            slug: 'actual-cli-approval',
            source_path: source,
            image_repo: 'registry.example/actual-cli',
            test_template: 'allow',
            requires_approval: true,
            health_check: {},
            policy_path: join(
              process.cwd(),
              'fixtures/policies/requires-approval.yaml',
            ),
          })
          .expect(201);
        const protectedDeployment = await createDeployment(
          protectedApp.body.application.id,
          'tester',
        );
        const waiting = await waitForStatus(
          protectedDeployment.id,
          'awaiting_approval',
          20_000,
        );
        const originalPlan = waiting.artifacts.find(
          (artifact: { name: string }) => artifact.name === 'plan',
        ).content;
        expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
        await api()
          .post(`/deployments/${protectedDeployment.id}/approve`)
          .set(
            'Authorization',
            `Bearer ${(await identity('reviewer')).access_token}`,
          )
          .send({})
          .expect(201);
        const approved = await waitForStatus(
          protectedDeployment.id,
          'succeeded',
          20_000,
        );
        expect(
          approved.artifacts.find(
            (artifact: { name: string }) => artifact.name === 'plan',
          ).content,
        ).toBe(originalPlan);
        const approval = JSON.parse(
          approved.artifacts.find(
            (artifact: { name: string }) => artifact.name === 'approval',
          ).content,
        );
        expect(approval.plan_sha256).toBe(
          createHash('sha256')
            .update(canonicalJson(JSON.parse(originalPlan)))
            .digest('hex'),
        );
        expect(
          approved.auditLogs.map((log: { kind: string }) => log.kind),
        ).toEqual(['deploy', 'sign']);
        expect(readdirSync(join(testDirectory, 'cli'))).toEqual([]);
      } finally {
        config.set('backend.stageMode', previousMode);
      }
    },
    30_000,
  );

  it('stops after a block policy result', async () => {
    const application = await createApplication(
      'blocked',
      false,
      {},
      'block-test-failed',
    );
    const deployment = await createDeployment(
      application.application.id,
      'requester-blocked',
    );
    const deploymentView = await waitForStatus(deployment.id, 'blocked');

    expect(deploymentView.deployment.decision).toBe('block');
    expect(deploymentView.policyResult.decision).toBe('block');
    expect(deploymentView.policyResult.targets).toEqual([]);
    expect(deploymentView.policyResult.failoverAllowed).toBe(false);
    expect(
      deploymentView.stages.map((stage: { stage: string }) => stage.stage),
    ).toEqual(['test', 'policy']);
    await api()
      .post(`/applications/${application.application.id}/targets`)
      .send({
        deployment_id: deployment.id,
        kind: 'cloud_run',
        url: 'https://blocked.example.run.app',
      })
      .expect(409)
      .expect((response) => {
        expect(response.body.message).toBe(
          'Deployment policy does not allow target',
        );
      });
  });

  it('requires a different user to approve a protected deployment', async () => {
    const application = await createApplication('protected', true);
    const deployment = await createDeployment(
      application.application.id,
      'requester-b',
    );
    await waitForStatus(deployment.id, 'awaiting_approval');

    await api()
      .post(`/deployments/${deployment.id}/approve`)
      .set(
        'Authorization',
        `Bearer ${(await identity('requester-b')).access_token}`,
      )
      .send({})
      .expect(403);

    await api()
      .post(`/deployments/${deployment.id}/approve`)
      .set(
        'Authorization',
        `Bearer ${(await identity('reviewer')).access_token}`,
      )
      .send({})
      .expect(201);

    const deploymentView = await waitForStatus(deployment.id, 'succeeded');
    expect(deploymentView.deployment).toMatchObject({
      approver: (await identity('reviewer')).id,
      decision: 'needs_approval',
      status: 'succeeded',
    });
  });

  it('registers an agent and assigns it to an application', async () => {
    const application = await createApplication('on-prem', false);
    const registration = await api()
      .post('/agents')
      .send({ name: 'agent-seoul-1' })
      .expect(201);

    expect(registration.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(registration.body.ssh_enrollment_token).toMatch(
      /^[A-Za-z0-9_-]{40,}$/,
    );
    expect(registration.body.ssh).toEqual({
      host: '127.0.0.1',
      port: expect.any(Number),
      user: 'hibiscus-agent',
      host_key_sha256: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/),
    });
    expect(registration.body.ssh.port).toBeGreaterThan(0);
    expect(registration.body.agent).not.toHaveProperty('tokenHash');

    const keys = sshUtils.generateKeyPairSync('ed25519', {
      comment: 'hibiscus:test-agent',
    });
    const enrollment = await request(app.getHttpServer())
      .post('/agent/v1/ssh/enroll')
      .set('Authorization', `Bearer ${registration.body.ssh_enrollment_token}`)
      .send({ public_key: keys.public })
      .expect(200);
    expect(enrollment.body).toMatchObject({
      agent_id: registration.body.agent.id,
      fingerprint: expect.stringMatching(/^SHA256:/),
    });
    await request(app.getHttpServer())
      .post('/agent/v1/ssh/enroll')
      .set('Authorization', `Bearer ${registration.body.ssh_enrollment_token}`)
      .send({ public_key: keys.public })
      .expect(401);

    const assignment = await api()
      .post(
        `/applications/${application.application.id}/agents/${registration.body.agent.id}`,
      )
      .expect(201);
    expect(assignment.body.agents).toEqual([
      expect.objectContaining({ id: registration.body.agent.id }),
    ]);
    expect(assignment.body.agents[0]).not.toHaveProperty('tokenHash');

    const agents = await api().get('/agents').expect(200);
    expect(agents.body[0]).not.toHaveProperty('tokenHash');
    expect(agents.body[0].sshEnrolledAt).toBeTruthy();
    expect(agents.body[0]).not.toHaveProperty('sshPublicKey');
  });

  it('stores routing targets and changes one application route with revision checks', async () => {
    const context = await createAgentContext('routing-manual');
    const target = await api()
      .post(`/applications/${context.applicationId}/targets`)
      .send({
        deployment_id: context.runId,
        kind: 'onprem',
        agent_id: context.agentId,
        local_port: 18081,
      })
      .expect(201);
    expect(target.body).toMatchObject({
      applicationId: context.applicationId,
      deploymentId: context.runId,
      kind: 'onprem',
      agentId: context.agentId,
      localPort: 18081,
    });

    const observedAt = new Date().toISOString();
    const health = app.get(RoutingService).recordHealth({
      targetId: target.body.id,
      deploymentId: context.runId,
      status: 'healthy',
      observedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reason: 'Health monitor passed',
    });
    expect(health).toMatchObject({
      targetId: target.body.id,
      status: 'healthy',
      observedAt,
    });
    await api()
      .get(`/applications/${context.applicationId}/targets`)
      .expect(200)
      .expect((response) => {
        expect(response.body[0].health.status).toBe('healthy');
      });

    const changed = await api()
      .patch(`/applications/${context.applicationId}/routing`)
      .send({
        target_id: target.body.id,
        expected_revision: 0,
        reason: 'Initial target',
      })
      .expect(200);
    expect(changed.body).toMatchObject({
      applicationId: context.applicationId,
      revision: 1,
      target: { id: target.body.id },
    });
    await api()
      .patch(`/applications/${context.applicationId}/routing`)
      .send({ target_id: target.body.id, expected_revision: 0 })
      .expect(409);
    await api()
      .get(`/applications/${context.applicationId}/routing`)
      .expect(200)
      .expect((response) => {
        expect(response.body.revision).toBe(1);
        expect(response.body.target.id).toBe(target.body.id);
      });
  });

  it('fails over from unhealthy on-prem to healthy Cloud Run after the configured threshold', async () => {
    const context = await createAgentContext('failover-route', {
      success_threshold: 1,
      failure_threshold: 2,
    });
    const onPrem = await api()
      .post(`/applications/${context.applicationId}/targets`)
      .send({
        deployment_id: context.runId,
        kind: 'onprem',
        agent_id: context.agentId,
        local_port: 18082,
      })
      .expect(201);
    const cloudRun = await api()
      .post(`/applications/${context.applicationId}/targets`)
      .send({
        deployment_id: context.runId,
        kind: 'cloud_run',
        url: 'https://failover-route.example.run.app',
      })
      .expect(201);
    await api()
      .patch(`/applications/${context.applicationId}/routing`)
      .send({ target_id: onPrem.body.id, expected_revision: 0 })
      .expect(200);

    const routing = app.get(RoutingService);
    const failover = app.get(FailoverService);
    const base = Date.now();
    routing.recordHealth({
      targetId: cloudRun.body.id,
      deploymentId: context.runId,
      status: 'healthy',
      observedAt: new Date(base).toISOString(),
      expiresAt: new Date(base + 60_000).toISOString(),
    });
    const firstFailure = routing.recordHealth({
      targetId: onPrem.body.id,
      deploymentId: context.runId,
      status: 'unhealthy',
      observedAt: new Date(base + 1_000).toISOString(),
      expiresAt: new Date(base + 60_000).toISOString(),
    });
    expect(firstFailure).toMatchObject({
      status: 'unknown',
      consecutiveFailures: 1,
    });
    expect(failover.handleUnhealthyTarget(onPrem.body.id)).toBe(false);

    const secondFailure = routing.recordHealth({
      targetId: onPrem.body.id,
      deploymentId: context.runId,
      status: 'unhealthy',
      observedAt: new Date(base + 2_000).toISOString(),
      expiresAt: new Date(base + 60_000).toISOString(),
    });
    expect(secondFailure).toMatchObject({
      status: 'unhealthy',
      consecutiveFailures: 2,
    });
    expect(failover.handleUnhealthyTarget(onPrem.body.id)).toBe(true);
    await api()
      .get(`/applications/${context.applicationId}/routing`)
      .expect(200)
      .expect((response) => {
        expect(response.body.revision).toBe(2);
        expect(response.body.target.id).toBe(cloudRun.body.id);
      });
  });

  it('uses an SSH reverse forward to carry Gateway requests to an on-prem port', async () => {
    const localServer = createServer((incoming, outgoing) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        body += chunk;
      });
      incoming.on('end', () => {
        outgoing.setHeader('x-hibiscus-tunnel', 'ok');
        outgoing.end(`${incoming.method} ${incoming.url} ${body}`);
      });
    });
    await new Promise<void>((resolve) =>
      localServer.listen(0, '127.0.0.1', resolve),
    );
    const localAddress = localServer.address();
    if (!localAddress || typeof localAddress === 'string') {
      throw new Error('Local test server did not start');
    }

    const context = await createAgentContext('tunnel-http');
    const target = await api()
      .post(`/applications/${context.applicationId}/targets`)
      .send({
        deployment_id: context.runId,
        kind: 'onprem',
        agent_id: context.agentId,
        local_port: localAddress.port,
      })
      .expect(201);
    expect(target.body.gatewayPort).toBeGreaterThanOrEqual(20_000);
    const forwards = await agentApi(context.token)
      .get('/agent/v1/forwards')
      .expect(200);
    expect(forwards.body).toEqual([
      {
        target_id: target.body.id,
        gateway_port: target.body.gatewayPort,
        local_port: localAddress.port,
      },
    ]);
    await api()
      .patch(`/applications/${context.applicationId}/routing`)
      .send({
        target_id: target.body.id,
        expected_revision: 0,
        reason: 'Gateway E2E target',
      })
      .expect(200);
    const keys = sshUtils.generateKeyPairSync('ed25519', {
      comment: `hibiscus:${context.agentId}`,
    });
    const enrollment = await request(app.getHttpServer())
      .post('/agent/v1/ssh/enroll')
      .set('Authorization', `Bearer ${context.sshEnrollmentToken}`)
      .send({ public_key: keys.public })
      .expect(200);
    const rejectedClient = new SshClient();
    rejectedClient.on('error', () => undefined);
    const unknownKeys = sshUtils.generateKeyPairSync('ed25519');
    await expect(
      new Promise<void>((resolve, reject) => {
        rejectedClient.once('ready', resolve);
        rejectedClient.once('error', reject);
        rejectedClient.connect({
          host: enrollment.body.ssh.host,
          port: enrollment.body.ssh.port,
          username: enrollment.body.ssh.user,
          privateKey: unknownKeys.private,
        });
      }),
    ).rejects.toBeTruthy();
    rejectedClient.destroy();

    const sshClient = new SshClient();
    sshClient.on('error', () => undefined);
    sshClient.on('tcp connection', (details, accept, reject) => {
      if (details.destPort !== target.body.gatewayPort) {
        reject();
        return;
      }
      const channel = accept();
      const localSocket = connect(localAddress.port, '127.0.0.1');
      channel.pipe(localSocket).pipe(channel);
    });
    await new Promise<void>((resolve, reject) => {
      sshClient.once('ready', resolve);
      sshClient.once('error', reject);
      sshClient.connect({
        host: enrollment.body.ssh.host,
        port: enrollment.body.ssh.port,
        username: enrollment.body.ssh.user,
        privateKey: keys.private,
        hostVerifier: (key) =>
          `SHA256:${createHash('sha256')
            .update(key)
            .digest('base64')
            .replace(/=+$/, '')}` === enrollment.body.ssh.host_key_sha256,
      });
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        sshClient.forwardIn('127.0.0.1', 65_534, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
    ).rejects.toBeTruthy();
    await expect(
      new Promise<void>((resolve, reject) => {
        sshClient.shell((error, stream) => {
          stream?.destroy();
          if (error) reject(error);
          else resolve();
        });
      }),
    ).rejects.toBeTruthy();
    await expect(
      new Promise<void>((resolve, reject) => {
        sshClient.forwardOut(
          '127.0.0.1',
          12_345,
          '127.0.0.1',
          localAddress.port,
          (error, stream) => {
            stream?.destroy();
            if (error) reject(error);
            else resolve();
          },
        );
      }),
    ).rejects.toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      sshClient.forwardIn('127.0.0.1', target.body.gatewayPort, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    let sshClientClosed = false;

    try {
      await request(app.getHttpServer())
        .post('/echo?value=gateway')
        .set('Host', 'tunnel-http.apps.test')
        .set('Content-Type', 'text/plain')
        .send('gateway')
        .expect(200)
        .expect('x-hibiscus-tunnel', 'ok')
        .expect('POST /echo?value=gateway gateway');
      await request(app.getHttpServer())
        .get('/_gateway/tunnel-http/dev-path')
        .expect(404);
      await api()
        .get(`/agents/${context.agentId}/tunnel`)
        .expect(200)
        .expect((result) => {
          expect(result.body.connected).toBe(true);
          expect(result.body.active_forwards).toBe(1);
        });
      await new Promise<void>((resolve, reject) => {
        sshClient.unforwardIn('127.0.0.1', target.body.gatewayPort, (error) =>
          error ? reject(error) : resolve(),
        );
      });
      await api()
        .get(`/agents/${context.agentId}/tunnel`)
        .expect(200)
        .expect((result) => expect(result.body.connected).toBe(false));
      await new Promise<void>((resolve, reject) => {
        sshClient.forwardIn('127.0.0.1', target.body.gatewayPort, (error) =>
          error ? reject(error) : resolve(),
        );
      });
      const disconnected = new Promise<void>((resolve) =>
        sshClient.once('close', resolve),
      );
      await request(app.getHttpServer())
        .delete(`/agents/${context.agentId}/token`)
        .set('Authorization', `Bearer ${defaultToken}`)
        .expect(200);
      await disconnected;
      sshClientClosed = true;
      await api()
        .get(`/agents/${context.agentId}/tunnel`)
        .expect(200)
        .expect((result) => expect(result.body.connected).toBe(false));
    } finally {
      if (!sshClientClosed) {
        await new Promise<void>((resolve) => {
          sshClient.once('close', resolve);
          sshClient.end();
        });
      }
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it('separates agent tokens from user JWTs and supports rotation and revocation', async () => {
    const context = await createAgentContext('agent-auth');
    await request(app.getHttpServer()).get('/agent/v1/jobs/next').expect(401);
    await api().get('/agent/v1/jobs/next').expect(401);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(204);
    await agentApi(context.token).get('/applications').expect(401);
    await request(app.getHttpServer())
      .get('/agent/v1/jobs/next')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    const stored = app.get(AgentRepository).find(context.agentId)!;
    expect(stored.tokenHash).toBe(
      createHash('sha256').update(context.token).digest('hex'),
    );
    const rotated = await api()
      .post(`/agents/${context.agentId}/token/rotate`)
      .send({})
      .expect(201);
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(rotated.body.token).not.toBe(context.token);
    expect(rotated.body.agent).not.toHaveProperty('tokenHash');
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(401);
    await agentApi(rotated.body.token).get('/agent/v1/jobs/next').expect(204);
    await request(app.getHttpServer())
      .delete(`/agents/${context.agentId}/token`)
      .set('Authorization', `Bearer ${defaultToken}`)
      .expect(200);
    await agentApi(rotated.body.token).get('/agent/v1/jobs/next').expect(401);
    const reactivated = await api()
      .post(`/agents/${context.agentId}/token/rotate`)
      .send({})
      .expect(201);
    await agentApi(reactivated.body.token)
      .get('/agent/v1/jobs/next')
      .expect(204);
    await agentApi(rotated.body.token).get('/agent/v1/jobs/next').expect(401);
  });

  it('stores heartbeat state and uses server time for online status', async () => {
    const context = await createAgentContext('agent-heartbeat');
    const heartbeat = {
      schema_version: 1,
      agent_id: context.agentId,
      updated_at: new Date().toISOString(),
      serving: {
        run_id: context.runId,
        digest: context.digest,
        container: 'app-current',
      },
      public_url: 'https://onprem.example.com',
    };
    const response = await agentApi(context.token)
      .post('/agent/v1/heartbeat')
      .send(heartbeat)
      .expect(200);
    expect(response.body).toMatchObject({
      agent_id: context.agentId,
      status: 'online',
      serving: heartbeat.serving,
      public_url: heartbeat.public_url,
    });
    expect(response.body.received_at).toBeTruthy();
    expect(response.body).not.toHaveProperty('tokenHash');
    await agentApi(context.token)
      .post('/agent/v1/heartbeat')
      .send({ ...heartbeat, agent_id: 'another-agent' })
      .expect(403);
    await agentApi(context.token)
      .post('/agent/v1/heartbeat')
      .send({ ...heartbeat, updated_at: '2000-01-01T00:00:00.000Z' })
      .expect(409);
    app
      .get(DatabaseService)
      .db.update(agents)
      .set({ lastSeenAt: '2000-01-01T00:00:00.000Z' })
      .where(eq(agents.id, context.agentId))
      .run();
    const offline = await api()
      .get(`/agents/${context.agentId}/status`)
      .expect(200);
    expect(offline.body.status).toBe('offline');
    expect(offline.body.serving).toEqual(heartbeat.serving);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(204);
    expect(
      (await api().get(`/agents/${context.agentId}/status`)).body.status,
    ).toBe('online');
  });

  it('leases one job, stores the contract result and accepts identical retransmissions', async () => {
    const context = await createAgentContext('agent-mailbox');
    const input = jobInput(context, 'candidate');
    await api().post(`/agents/${context.agentId}/jobs`).send(input).expect(201);
    const duplicate = await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send(input)
      .expect(201);
    expect(duplicate.body.status).toBe('queued');
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send({ ...input, plan_hash: 'b'.repeat(64) })
      .expect(409);
    const responses = await Promise.all([
      agentApi(context.token).get('/agent/v1/jobs/next'),
      agentApi(context.token).get('/agent/v1/jobs/next'),
    ]);
    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([200, 204]);
    const job = responses.find((response) => response.status === 200)!.body;
    expect(job).toMatchObject({
      schema_version: 1,
      job_id: input.job_id,
      agent_id: context.agentId,
      run_id: context.runId,
      action: 'candidate',
      digest: context.digest,
      attempt: 1,
      runtime: { container_port: 8080 },
      health_check: {
        enabled: true,
        path: '/health',
        method: 'GET',
      },
    });
    expect(Date.parse(job.lease_until)).toBeLessThanOrEqual(
      Date.parse(job.deadline),
    );
    const result = {
      schema_version: 1,
      agent_id: context.agentId,
      job_id: job.job_id,
      run_id: context.runId,
      action: 'candidate',
      attempt: 1,
      result: 'ok',
      candidate: {
        digest: context.digest,
        container: 'candidate-01',
        url: 'http://127.0.0.1:18081',
      },
      check: {
        run_id: context.runId,
        target: 'onprem',
        mode: 'candidate',
        pass: true,
        checks: [],
        provider_metadata: { preserved: true },
      },
      finished_at: new Date().toISOString(),
    };
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${job.job_id}/result`)
      .send({ ...result, agent_id: 'another-agent' })
      .expect(409);
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${job.job_id}/result`)
      .send(result)
      .expect(200, result);
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${job.job_id}/result`)
      .send(result)
      .expect(200, result);
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${job.job_id}/result`)
      .send({
        ...result,
        candidate: { ...result.candidate, container: 'different' },
      })
      .expect(409);
    const stored = await api()
      .get(`/agents/${context.agentId}/jobs/${job.job_id}`)
      .expect(200);
    expect(stored.body.status).toBe('succeeded');
    expect(stored.body.results).toHaveLength(1);
    expect(stored.body.results[0].payload).toEqual(result);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(204);
  });

  it('checks app assignment, job ownership and required action fields', async () => {
    const context = await createAgentContext('agent-isolation');
    const other = await api()
      .post('/agents')
      .send({ name: 'agent-isolation-other' })
      .expect(201);
    const input = jobInput(context, 'candidate');
    await api()
      .post(`/agents/${other.body.agent.id}/jobs`)
      .send(input)
      .expect(403);
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send({ ...input, digest: `sha256:${'b'.repeat(64)}` })
      .expect(409);
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send({ ...input, image: undefined })
      .expect(400);
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send({ ...jobInput(context, 'rollback'), to_digest: undefined })
      .expect(400);
    await api().post(`/agents/${context.agentId}/jobs`).send(input).expect(201);
    await agentApi(other.body.token).get('/agent/v1/jobs/next').expect(204);
    await api()
      .get(`/agents/${other.body.agent.id}/jobs/${input.job_id}`)
      .expect(404);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(200);
    const result = {
      schema_version: 1,
      agent_id: other.body.agent.id,
      job_id: input.job_id,
      run_id: context.runId,
      action: 'candidate',
      attempt: 1,
      result: 'error',
      error: 'Test failure',
      finished_at: new Date().toISOString(),
    };
    await agentApi(other.body.token)
      .post(`/agent/v1/jobs/${input.job_id}/result`)
      .send(result)
      .expect(404);
  });

  it('reclaims expired leases with a new attempt and rejects stale results', async () => {
    const context = await createAgentContext('agent-retry');
    const input = jobInput(context, 'candidate');
    await api().post(`/agents/${context.agentId}/jobs`).send(input).expect(201);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(200);
    app
      .get(DatabaseService)
      .db.update(agentJobs)
      .set({ leaseUntil: '2000-01-01T00:00:00.000Z' })
      .where(eq(agentJobs.id, input.job_id))
      .run();
    const reclaimed = await agentApi(context.token)
      .get('/agent/v1/jobs/next')
      .expect(200);
    expect(reclaimed.body.attempt).toBe(2);
    const result = {
      schema_version: 1,
      agent_id: context.agentId,
      job_id: input.job_id,
      run_id: context.runId,
      action: 'candidate',
      attempt: 1,
      result: 'error',
      error: 'Test failure',
      finished_at: new Date().toISOString(),
    };
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${input.job_id}/result`)
      .send(result)
      .expect(409);
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${input.job_id}/result`)
      .send({ ...result, attempt: 2 })
      .expect(200);
    const stored = await api()
      .get(`/agents/${context.agentId}/jobs/${input.job_id}`)
      .expect(200);
    expect(stored.body.status).toBe('failed');
    expect(stored.body.results).toHaveLength(1);
    expect(stored.body.results[0].payload.attempt).toBe(2);
  });

  it('does not lease expired jobs or accept a result after the deadline', async () => {
    const context = await createAgentContext('agent-deadline');
    const input = jobInput(context, 'discard');
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send({ ...input, deadline: '2000-01-01T00:00:00.000Z' })
      .expect(400);
    await api().post(`/agents/${context.agentId}/jobs`).send(input).expect(201);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(200);
    app
      .get(DatabaseService)
      .db.update(agentJobs)
      .set({ deadline: '2000-01-01T00:00:00.000Z' })
      .where(eq(agentJobs.id, input.job_id))
      .run();
    const result = {
      schema_version: 1,
      agent_id: context.agentId,
      job_id: input.job_id,
      run_id: context.runId,
      action: 'discard',
      attempt: 1,
      result: 'ok',
      finished_at: new Date().toISOString(),
    };
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${input.job_id}/result`)
      .send(result)
      .expect(409);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(204);
    expect(
      (await api().get(`/agents/${context.agentId}/jobs/${input.job_id}`)).body
        .status,
    ).toBe('expired');
  });

  it.each(['activate', 'rollback', 'discard'] as const)(
    'stores the %s action result',
    async (action) => {
      const context = await createAgentContext(`agent-action-${action}`);
      const input = jobInput(context, action);
      await api()
        .post(`/agents/${context.agentId}/jobs`)
        .send(input)
        .expect(201);
      const job = await agentApi(context.token)
        .get('/agent/v1/jobs/next')
        .expect(200);
      const result = {
        schema_version: 1,
        agent_id: context.agentId,
        job_id: input.job_id,
        run_id: context.runId,
        action,
        attempt: job.body.attempt,
        result: 'ok',
        ...(action === 'discard'
          ? {}
          : {
              serving: {
                run_id: context.runId,
                digest:
                  action === 'rollback' ? input.to_digest : context.digest,
                container: 'serving',
              },
            }),
        finished_at: new Date().toISOString(),
      };
      await agentApi(context.token)
        .post(`/agent/v1/jobs/${input.job_id}/result`)
        .send(result)
        .expect(200, result);
    },
  );

  it('preserves tokens, job results, leases and heartbeat state after a restart', async () => {
    const context = await createAgentContext('agent-persistence');
    const discard = jobInput(context, 'discard');
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send(discard)
      .expect(201);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(200);
    const result = {
      schema_version: 1,
      agent_id: context.agentId,
      job_id: discard.job_id,
      run_id: context.runId,
      action: 'discard',
      attempt: 1,
      result: 'ok',
      finished_at: new Date().toISOString(),
    };
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${discard.job_id}/result`)
      .send(result)
      .expect(200);
    const candidate = jobInput(context, 'candidate');
    await api()
      .post(`/agents/${context.agentId}/jobs`)
      .send(candidate)
      .expect(201);
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(200);
    await agentApi(context.token)
      .post('/agent/v1/heartbeat')
      .send({
        schema_version: 1,
        agent_id: context.agentId,
        updated_at: new Date().toISOString(),
        serving: null,
        public_url: 'https://persisted.example.com',
      })
      .expect(200);
    await app.close();
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    auth = app.get(AuthService);
    users = app.get(UserService);
    const status = await agentApi(context.token)
      .get('/agent/v1/status')
      .expect(200);
    expect(status.body.public_url).toBe('https://persisted.example.com');
    await agentApi(context.token).get('/agent/v1/jobs/next').expect(204);
    const stored = await api()
      .get(`/agents/${context.agentId}/jobs/${discard.job_id}`)
      .expect(200);
    expect(stored.body.results[0].payload).toEqual(result);
    await agentApi(context.token)
      .post(`/agent/v1/jobs/${discard.job_id}/result`)
      .send(result)
      .expect(200);
    app
      .get(DatabaseService)
      .db.update(agentJobs)
      .set({ leaseUntil: '2000-01-01T00:00:00.000Z' })
      .where(eq(agentJobs.id, candidate.job_id))
      .run();
    expect(
      (await agentApi(context.token).get('/agent/v1/jobs/next').expect(200))
        .body.attempt,
    ).toBe(2);
  });

  async function createAgentContext(
    name: string,
    healthCheck: Record<string, unknown> = {},
  ) {
    const application = await createApplication(name, false, healthCheck);
    const deployment = await createDeployment(
      application.application.id,
      'tester',
    );
    const view = await waitForStatus(deployment.id, 'succeeded');
    const registered = await api().post('/agents').send({ name }).expect(201);
    const agentId: string = registered.body.agent.id;
    await api()
      .post(`/applications/${application.application.id}/agents/${agentId}`)
      .expect(201);
    return {
      applicationId: application.application.id as string,
      agentId,
      token: registered.body.token as string,
      sshEnrollmentToken: registered.body.ssh_enrollment_token as string,
      runId: deployment.id as string,
      digest: deployment.imageDigest as string,
      imageRepo: application.application.imageRepo as string,
      planHash: view.policyResult.planHash as string,
    };
  }

  function jobInput(
    context: {
      runId: string;
      digest: string;
      imageRepo: string;
      planHash: string;
    },
    action: 'candidate' | 'activate' | 'rollback' | 'discard',
  ) {
    return {
      job_id: `${context.runId}-${action}-01`,
      run_id: context.runId,
      action,
      digest: context.digest,
      ...(action === 'candidate'
        ? {
            image: `${context.imageRepo}@${context.digest}`,
            plan_hash: context.planHash,
          }
        : {}),
      ...(action === 'rollback'
        ? { to_digest: `sha256:${'b'.repeat(64)}` }
        : {}),
      deadline: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  function agentApi(token: string) {
    return {
      get: (url: string) =>
        request(app.getHttpServer())
          .get(url)
          .set('Authorization', `Bearer ${token}`),
      post: (url: string) =>
        request(app.getHttpServer())
          .post(url)
          .set('Authorization', `Bearer ${token}`),
    };
  }

  async function createApplication(
    name: string,
    requiresApproval: boolean,
    healthCheck: Record<string, unknown> = {},
    testTemplate: 'allow' | 'block-test-failed' = 'allow',
  ) {
    const response = await api()
      .post('/applications')
      .send({
        name,
        slug: name,
        source_path: `./fixtures/${name}`,
        image_repo: `registry.example/${name}`,
        requires_approval: requiresApproval,
        test_template: testTemplate,
        health_check: healthCheck,
      })
      .expect(201);
    return response.body;
  }

  async function createDeployment(
    applicationId: string,
    requester: string,
    digestCharacter = 'a',
  ) {
    const response = await api()
      .post(`/applications/${applicationId}/deployments`)
      .set(
        'Authorization',
        `Bearer ${(await identity(requester)).access_token}`,
      )
      .send({
        source_revision: '0123456789abcdef',
        image_digest: `sha256:${digestCharacter.repeat(64)}`,
      })
      .expect(201);
    return response.body;
  }

  async function identity(login: string) {
    const existing = identities.get(login);
    if (existing) return existing;
    const user = users.upsertGithub({ id: identities.size + 1, login });
    const tokens = await auth.issueTokens(user);
    const result = { id: user.id, access_token: tokens.access_token };
    identities.set(login, result);
    return result;
  }

  function api() {
    const server = app.getHttpServer();
    return {
      get: (url: string) =>
        request(server).get(url).set('Authorization', `Bearer ${defaultToken}`),
      post: (url: string) =>
        request(server)
          .post(url)
          .set('Authorization', `Bearer ${defaultToken}`),
      patch: (url: string) =>
        request(server)
          .patch(url)
          .set('Authorization', `Bearer ${defaultToken}`),
    };
  }

  async function waitForStatus(
    deploymentId: string,
    expectedStatus: string,
    timeoutMs = 2_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await api()
        .get(`/deployments/${deploymentId}`)
        .expect(200);
      if (response.body.deployment.status === expectedStatus) {
        return response.body;
      }
      if (
        response.body.deployment.status === 'failed' &&
        expectedStatus !== 'failed'
      )
        throw new Error(response.body.deployment.error);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Deployment가 ${expectedStatus} 상태가 되지 않음`);
  }

  afterAll(async () => {
    await app.close();
    rmSync(testDirectory, { recursive: true, force: true });
    delete process.env.DATABASE_FILE;
    delete process.env.WORKER_POLL_MS;
    delete process.env.CLI_TEMP_DIR;
    delete process.env.JWT_ACCESS_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    delete process.env.ALLOWED_GITHUB_IDS;
    delete process.env.HEALTH_MONITOR_ENABLED;
    delete process.env.GATEWAY_BASE_DOMAIN;
    delete process.env.SSH_SERVER_ENABLED;
    delete process.env.SSH_BIND_HOST;
    delete process.env.SSH_HOST;
    delete process.env.SSH_PORT;
    delete process.env.SSH_HOST_KEY_FILE;
  });
});
