import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AgentJobService } from '../src/agent/agent-job.service.js';
import type { AgentJobResultDto } from '../src/agent/dto/agent-job.dto.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DeploymentRepository } from '../src/deployment/deployment.repository.js';
import { DeployStage } from '../src/deployment/stages/deploy.stage.js';
import { DeploymentPaths } from '../src/deployment/types/deployment.type.js';
import type { DeployResult } from '../src/deployment/types/deploy-result.type.js';
import { RoutingService } from '../src/routing/routing.service.js';
import { UserService } from '../src/user/user.service.js';
import { ApplicationRepository } from '../src/application/application.repository.js';

// 실제 Nest 앱에서 배포 단계를 돌린다. gcloud·cosign 은 가짜 스크립트, 온프레 Agent 는 작업 API 를 직접 부르는 가짜.
describe('deploy stage (e2e)', () => {
  let app: INestApplication<App>;
  let directory: string;
  let scripts: string;
  let token: string;
  let userId: string;
  const candidateEnvironments = new Map<string, Record<string, string>>();
  const imageRepo = 'registry.example/demo';

  const write = (name: string, body: string) => {
    const path = join(scripts, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'deploy-stage-'));
    scripts = join(directory, 'scripts');
    mkdirSync(scripts);
    const log = join(directory, 'calls.log');
    const record = `echo "$(basename "$0") $* PROJECT_ID=$PROJECT_ID REGION=$REGION SERVICE=$SERVICE PORT=$PORT TAG=$TAG" >> ${log}`;
    write(
      'candidate.sh',
      `${record}\ncat "$4" >> ${log}\necho >> ${log}\necho '{"target":"cloud_run","phase":"candidate","result":"ok","revision":"demo-d1","candidate_url":"https://cand---demo-abc.a.run.app"}'`,
    );
    write(
      'activate.sh',
      `${record}\necho '{"target":"cloud_run","phase":"activate","result":"ok","previous":"demo-old","serving":"demo-d1"}'`,
    );
    write('discard.sh', `${record}\necho '{"result":"ok"}'`);
    write('rollback.sh', `${record}\necho '{"result":"ok"}'`);
    write('cosign', `echo "cosign $*" >> ${log}`);

    Object.assign(process.env, {
      DATABASE_FILE: join(directory, 'test.db'),
      WORKER_POLL_MS: '50',
      CLI_TEMP_DIR: join(directory, 'cli'),
      JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      GITHUB_APP_CLIENT_ID: 'Iv1.test-client',
      GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
      ALLOWED_GITHUB_IDS: '1',
      HEALTH_MONITOR_ENABLED: 'false',
      SSH_SERVER_ENABLED: 'false',
      SSH_HOST: '127.0.0.1',
      DEPLOY_MODE: 'real',
      GCP_PROJECT_ID: 'test-project',
      GCP_REGION: 'asia-northeast3',
      CLOUD_RUN_SCRIPTS_DIR: scripts,
      COSIGN_COMMAND: join(scripts, 'cosign'),
      DEPLOY_JOB_POLL_MS: '50',
      DEPLOY_CANDIDATE_TIMEOUT_MS: '5000',
      DEPLOY_ACTION_TIMEOUT_MS: '5000',
    });
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
    const user = app.get(UserService).upsertGithub({ id: 1, login: 'junha' });
    userId = user.id;
    token = (await app.get(AuthService).issueTokens(user)).access_token;
  });

  afterAll(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    for (const key of [
      'DATABASE_FILE',
      'WORKER_POLL_MS',
      'CLI_TEMP_DIR',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'ALLOWED_GITHUB_IDS',
      'HEALTH_MONITOR_ENABLED',
      'SSH_SERVER_ENABLED',
      'SSH_HOST',
      'DEPLOY_MODE',
      'GCP_PROJECT_ID',
      'GCP_REGION',
      'CLOUD_RUN_SCRIPTS_DIR',
      'COSIGN_COMMAND',
      'DEPLOY_JOB_POLL_MS',
      'DEPLOY_CANDIDATE_TIMEOUT_MS',
      'DEPLOY_ACTION_TIMEOUT_MS',
    ])
      delete process.env[key];
  });

  const api = () => ({
    post: (url: string) =>
      request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`),
    put: (url: string) =>
      request(app.getHttpServer())
        .put(url)
        .set('Authorization', `Bearer ${token}`),
  });

  async function setupApplication(slug: string) {
    const created = await api()
      .post('/applications')
      .send({
        name: slug,
        slug,
        source_path: `./fixtures/${slug}`,
        image_repo: imageRepo,
        container_port: 80,
        health_check: { enabled: false },
        environment: [{ name: 'DATABASE_URL', value: 'postgres://shared/app' }],
      })
      .expect(201);
    const applicationId: string = created.body.application.id;
    const agent = await api()
      .post('/agents')
      .send({ name: `${slug}-agent` });
    const agentId: string = agent.body.agent.id;
    await api()
      .post(`/applications/${applicationId}/agents/${agentId}`)
      .expect(201);
    return { applicationId, agentId };
  }

  function createDeployment(
    applicationId: string,
    digest: string,
    sourceRevisionVerified = true,
  ) {
    const now = new Date().toISOString();
    // Worker 가 집어 가지 않게 running 으로 만든다. 단계는 테스트에서 직접 실행한다
    return app.get(DeploymentRepository).create(
      {
        id: randomUUID(),
        applicationId,
        trigger: 'manual',
        sourceRevision: '0123456789abcdef0123456789abcdef01234567',
        sourceRevisionVerified,
        imageDigest: digest,
        digestSource: 'registry',
        requester: userId,
        approver: null,
        decision: 'allow',
        status: 'running',
        currentStage: 'deploy',
        error: null,
        workDir: '',
        executionMode: 'cli',
        deploymentPerformed: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        runtime: app
          .get(ApplicationRepository)
          .runtimeEnvironment(applicationId),
        test: app.get(ApplicationRepository).testEnvironment(applicationId),
      },
    );
  }

  function prepare(deploymentId: string, digest: string) {
    const paths = new DeploymentPaths(join(directory, 'cli'), deploymentId);
    paths.ensure();
    const now = new Date().toISOString();
    const planHash = 'b'.repeat(64);
    const signResult = JSON.stringify({
      run_id: deploymentId,
      digest,
      plan_hash: planHash,
      targets: ['onprem', 'cloud_run'],
      failover_allowed: true,
      requester: userId,
      approver: 'auto',
      signature_ref: `cosign:${imageRepo}@${digest}`,
      signed_at: now,
    });
    writeFileSync(join(paths.sign, 'sign_result.json'), signResult);
    // Routing 은 서명된 정책 결과가 있는 배포만 허용한다. 앞 단계가 남기는 기록을 직접 만든다
    const repository = app.get(DeploymentRepository);
    repository.savePolicyResult({
      deploymentId,
      decision: 'allow',
      planHash,
      targets: ['onprem', 'cloud_run'],
      failoverAllowed: true,
      requires: [],
      planPath: null,
      piiPath: null,
      planArtifactId: null,
      piiArtifactId: null,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = randomUUID();
    repository.createStage({
      id: stageId,
      deploymentId,
      sequence: 3,
      attempt: 1,
      stage: 'sign',
      status: 'succeeded',
      exitCode: 0,
      startedAt: now,
      finishedAt: now,
      artifacts: {},
      summary: null,
      error: null,
    });
    repository.checkpoint(
      [
        {
          id: randomUUID(),
          deploymentId,
          stageExecutionId: stageId,
          name: 'sign_result',
          relativePath: 'sign/sign_result.json',
          mediaType: 'application/json',
          content: signResult,
          contentHash: createHash('sha256').update(signResult).digest('hex'),
          schemaName: null,
          validationError: null,
          createdAt: now,
        },
      ],
      [],
      () => undefined,
    );
    return paths;
  }

  // 작업 API 로 Agent 를 흉내 낸다. candidateFails 면 후보 작업에 error 를 보낸다
  function fakeAgent(agentId: string, candidateFails = false) {
    const jobs = app.get(AgentJobService);
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        const job = jobs.next(agentId);
        if (job) {
          if (job.action === 'candidate')
            candidateEnvironments.set(
              job.run_id,
              job.runtime.environment ?? {},
            );
          const base = {
            schema_version: 1,
            agent_id: agentId,
            job_id: job.job_id,
            run_id: job.run_id,
            action: job.action,
            attempt: job.attempt,
            finished_at: new Date().toISOString(),
          };
          const serving = {
            run_id: job.run_id,
            digest: job.digest,
            container: `hibiscus-${job.run_id}`,
          };
          const body =
            job.action === 'candidate' && candidateFails
              ? { ...base, result: 'error', error: 'health check failed' }
              : job.action === 'candidate'
                ? {
                    ...base,
                    result: 'ok',
                    candidate: {
                      digest: job.digest,
                      container: serving.container,
                      url: 'http://127.0.0.1:18081',
                    },
                    check: { mode: 'candidate', pass: true, checks: [] },
                  }
                : job.action === 'activate'
                  ? {
                      ...base,
                      result: 'ok',
                      previous: {
                        run_id: 'run-old',
                        digest: `sha256:${'0'.repeat(64)}`,
                        container: 'hibiscus-run-old',
                      },
                      serving,
                    }
                  : job.action === 'rollback'
                    ? {
                        ...base,
                        result: 'ok',
                        serving: {
                          run_id: 'run-old',
                          digest: job.to_digest,
                          container: 'hibiscus-run-old',
                        },
                      }
                    : { ...base, result: 'ok' };
          jobs.submit(agentId, job.job_id, body as AgentJobResultDto);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const running = loop();
    return async () => {
      stopped = true;
      await running;
    };
  }

  it('deploys to Cloud Run and on-prem, then routes to the on-prem target', async () => {
    const { applicationId, agentId } = await setupApplication('demo');
    const digest = `sha256:${'a'.repeat(64)}`;
    const deployment = createDeployment(applicationId, digest);
    await api()
      .put(`/applications/${applicationId}/environment`)
      .send({
        environment: [
          { name: 'DATABASE_URL', value: 'postgres://changed/app' },
        ],
      })
      .expect(200);
    const paths = prepare(deployment.id, digest);
    const stop = fakeAgent(agentId);
    const application = app.get(ApplicationRepository).find(applicationId)!;

    const outcome = await app
      .get(DeployStage)
      .run({ application, deployment, paths });
    await stop();

    const result = JSON.parse(
      readFileSync(join(paths.deploy, 'deploy_result.json'), 'utf8'),
    ) as DeployResult;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.deploymentPatch).toEqual({ deploymentPerformed: true });
    expect(result.decision).toBe('activated');
    expect(
      result.targets.map((step) => `${step.target}:${step.phase}`),
    ).toEqual([
      'cloud_run:candidate',
      'onprem:candidate',
      'cloud_run:activate',
      'onprem:activate',
    ]);

    const route = app.get(RoutingService).getRoute(applicationId);
    expect(route.target).toMatchObject({ kind: 'onprem', localPort: 18081 });
    const targets = app.get(RoutingService).listTargets(applicationId);
    expect(
      targets.find(({ target }) => target.kind === 'cloud_run')?.target,
    ).toMatchObject({ url: 'https://demo-abc.a.run.app', enabled: true });

    const calls = readFileSync(join(directory, 'calls.log'), 'utf8');
    expect(calls).toContain(
      `candidate.sh ${imageRepo}@${digest}  ${deployment.id} `,
    );
    expect(calls).toContain('"DATABASE_URL":"postgres://shared/app"');
    expect(calls).not.toContain('postgres://changed/app');
    expect(candidateEnvironments.get(deployment.id)).toEqual({
      DATABASE_URL: 'postgres://shared/app',
    });
    expect(calls).toContain(`"HIB_RUN_ID":"${deployment.id}"`);
    expect(calls).toContain(`-a run_id=${deployment.id}`);
    paths.cleanup();
  });

  it('holds and discards both candidates when the on-prem candidate fails', async () => {
    const { applicationId, agentId } = await setupApplication('held-demo');
    const digest = `sha256:${'f'.repeat(64)}`;
    const deployment = createDeployment(applicationId, digest);
    const paths = prepare(deployment.id, digest);
    const stop = fakeAgent(agentId, true);
    const application = app.get(ApplicationRepository).find(applicationId)!;

    const outcome = await app
      .get(DeployStage)
      .run({ application, deployment, paths });
    await stop();

    expect(outcome).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(outcome.error).toContain('held');
    const result = JSON.parse(
      readFileSync(join(paths.deploy, 'deploy_result.json'), 'utf8'),
    ) as DeployResult;
    expect(result.decision).toBe('held');
    expect(
      result.targets.some(
        (step) => step.target === 'cloud_run' && step.phase === 'discard',
      ),
    ).toBe(true);
    expect(() => app.get(RoutingService).getRoute(applicationId)).toThrow();
    paths.cleanup();
  });
  it('rolls back and records a failure when the routing switch fails', async () => {
    const { applicationId, agentId } = await setupApplication('routing-fail');
    const digest = `sha256:${'d'.repeat(64)}`;
    const deployment = createDeployment(applicationId, digest);
    const paths = prepare(deployment.id, digest);
    const stop = fakeAgent(agentId);
    const application = app.get(ApplicationRepository).find(applicationId)!;
    const changeRoute = vi
      .spyOn(app.get(RoutingService), 'changeRoute')
      .mockImplementationOnce(() => {
        throw new Error('Routing revision does not match');
      });

    const outcome = await app
      .get(DeployStage)
      .run({ application, deployment, paths });
    await stop();
    changeRoute.mockRestore();

    expect(outcome).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(outcome.deploymentPatch).toEqual({ deploymentPerformed: false });
    expect(outcome.error).toContain('Routing switch failed');
    const result = JSON.parse(
      readFileSync(join(paths.deploy, 'deploy_result.json'), 'utf8'),
    ) as DeployResult;
    expect(result.decision).toBe('rolled_back');
    expect(result.routing).toMatchObject({ result: 'error' });
    expect(
      result.targets.map(
        (step) => `${step.target}:${step.phase}:${step.result}`,
      ),
    ).toEqual([
      'cloud_run:candidate:ok',
      'onprem:candidate:ok',
      'cloud_run:activate:ok',
      'onprem:activate:ok',
      'cloud_run:rollback:ok',
      'onprem:rollback:ok',
    ]);
    expect(() => app.get(RoutingService).getRoute(applicationId)).toThrow();
    paths.cleanup();
  });

  it('refuses an unverified source revision before touching any target', async () => {
    const { applicationId } = await setupApplication('unverified-demo');
    const digest = `sha256:${'c'.repeat(64)}`;
    const deployment = createDeployment(applicationId, digest, false);
    const paths = prepare(deployment.id, digest);
    const application = app.get(ApplicationRepository).find(applicationId)!;
    const log = join(directory, 'calls.log');
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    const before = calls();

    const outcome = await app
      .get(DeployStage)
      .run({ application, deployment, paths });

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.error).toContain('verified source revision');
    expect(calls()).toBe(before);
    paths.cleanup();
  });
});
