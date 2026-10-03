import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service.js';
import { UserService } from '../src/user/user.service.js';
import { DeploymentRepository } from '../src/deployment/deployment.repository.js';

// Opt-in real Docker test. The launcher supplies only a loopback registry.
const liveFile = process.env.PARITY_LIVE_INPUTS;
describe.skipIf(!liveFile)('real parity through the Backend worker', () => {
  it('builds the image, checkpoints its identity, and blocks the broken guestbook', async () => {
    const input = JSON.parse(readFileSync(liveFile!, 'utf8')) as {
      root: string;
      source: string;
      sourceRevision: string;
      imageRepo: string;
      builder: string;
      python: string;
      output: string;
    };
    if (!/^localhost:[0-9]+\/[a-z0-9/-]+$/.test(input.imageRepo)) {
      throw new Error('This rehearsal accepts only a local registry');
    }
    Object.assign(process.env, {
      DATABASE_FILE: join(input.output, 'backend.db'),
      CLI_TEMP_DIR: join(input.output, 'work'),
      WORKER_POLL_MS: '50',
      REPO_ROOT: input.root,
      STAGE_MODE: 'cli',
      SIGNER_MODE: 'dry',
      DEPLOY_MODE: 'off',
      PARITY_TEST_MODE: 'registry',
      PARITY_BUILDER: input.builder,
      PARITY_PYTHON_COMMAND: input.python,
      PARITY_PLATFORMS: 'linux/amd64',
      JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
      GITHUB_APP_CLIENT_ID: 'local-rehearsal',
      GITHUB_APP_CLIENT_SECRET: 'local-only',
      ALLOWED_GITHUB_IDS: '424242',
      HEALTH_MONITOR_ENABLED: 'false',
      SSH_SERVER_ENABLED: 'false',
      SSH_HOST: '127.0.0.1',
    });
    delete process.env.ANTHROPIC_API_KEY;
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    try {
      const user = app
        .get(UserService)
        .upsertGithub({ id: 424242, login: 'local-rehearsal' });
      const token = (await app.get(AuthService).issueTokens(user)).access_token;
      const post = (path: string) =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`);
      const application = await post('/applications')
        .send({
          name: 'guestbook',
          slug: 'guestbook',
          source_path: input.source,
          image_repo: input.imageRepo,
          container_port: 8080,
          requires_approval: false,
        })
        .expect(201);
      const created = await post(
        `/applications/${application.body.application.id}/deployments`,
      )
        .send({ source_revision: input.sourceRevision })
        .expect(201);
      expect(created.body.digestSource).toBe('placeholder');
      expect(created.body.sourceRevisionVerified).toBe(false);
      const repository = app.get(DeploymentRepository);
      const wait = async (id: string) => {
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          const deployment = repository.find(id)!;
          if (
            ['blocked', 'failed', 'succeeded', 'awaiting_approval'].includes(
              deployment.status,
            )
          )
            return deployment;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('Real parity worker timed out');
      };
      const finished = await wait(created.body.id);
      const view = repository.getView(finished.id)!;
      const artifacts = repository.listArtifacts(finished.id, true);
      writeFileSync(
        join(input.output, 'backend-result.json'),
        JSON.stringify(
          {
            deployment: finished,
            view,
            artifacts,
            live_llm_calls: 0,
            signing_executed: false,
            deployment_executed: false,
          },
          null,
          2,
        ),
      );
      expect(finished.status, finished.error ?? JSON.stringify(view)).toBe(
        'blocked',
      );
      expect(finished.digestSource).toBe('registry');
      expect(finished.sourceRevisionVerified).toBe(true);
      expect(finished.imageDigest).not.toBe(created.body.imageDigest);
      expect(finished.deploymentPerformed).toBe(false);
      expect(artifacts.every((a) => a.validationError === null)).toBe(true);
      const normalized = JSON.parse(
        artifacts.find((a) => a.relativePath === 'test/test_result.json')!
          .content,
      );
      const plan = JSON.parse(
        artifacts.find((a) => a.relativePath === 'policy/plan.json')!.content,
      );
      expect(normalized.passed).toBe(false);
      expect(plan.decision).toBe('block');
      for (const record of [normalized, plan]) {
        expect(record.run_id).toBe(finished.id);
        expect(record.digest).toBe(finished.imageDigest);
        expect(record.source_revision).toBe(input.sourceRevision);
      }
      expect(artifacts.some((a) => a.relativePath.startsWith('sign/'))).toBe(
        false,
      );
      expect(artifacts.some((a) => a.relativePath.startsWith('deploy/'))).toBe(
        false,
      );

      // A different source revision must fail before building or policy evaluation.
      const rejected = await post(
        `/applications/${application.body.application.id}/deployments`,
      )
        .send({ source_revision: '0'.repeat(40) })
        .expect(201);
      const mismatch = await wait(rejected.body.id);
      expect(mismatch.status).toBe('failed');
      expect(mismatch.digestSource).toBe('placeholder');
      expect(mismatch.sourceRevisionVerified).toBe(false);
      expect(mismatch.error).toContain(
        'does not match the requested source SHA',
      );
      writeFileSync(
        join(input.output, 'backend-negative-result.json'),
        JSON.stringify(mismatch, null, 2),
      );
    } finally {
      await app.close();
    }
  }, 300_000);
});
