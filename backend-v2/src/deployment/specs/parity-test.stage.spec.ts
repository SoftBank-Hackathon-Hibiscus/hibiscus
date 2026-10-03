import { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ParityTestStage } from '../stages/parity-test.stage.js';
import { DeploymentArtifactService } from '../deployment-artifact.service.js';
import {
  DeploymentPaths,
  type StageContext,
} from '../types/deployment.type.js';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { StageExecution } from '../../database/schema.js';
import { GithubSourceCheckoutService } from '../../github/github-source-checkout.service.js';
import { ParityInputService } from '../parity-input.service.js';

describe('registry parity connection', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const path of directories.splice(0))
      rmSync(path, { recursive: true, force: true });
  });

  function setup(
    digestSource: 'registry' | 'placeholder' = 'registry',
    withParity = true,
  ) {
    const root = mkdtempSync(join(tmpdir(), 'parity-stage-'));
    directories.push(root);
    const paths = new DeploymentPaths(root, 'test-run');
    paths.ensure();
    const manifestDir = join(root, 'manifests', 'test-run');
    mkdirSync(manifestDir, { recursive: true });
    if (withParity) writeParity(root, 'candidate');
    const digest = `sha256:${'a'.repeat(64)}`;
    const context = {
      application: {
        id: 'application-1',
        name: 'guestbook',
        slug: 'guestbook',
        sourcePath: root,
        imageRepo: 'localhost:15002/guestbook',
        containerPort: 8080,
      },
      deployment: {
        id: 'test-run',
        applicationId: 'application-1',
        sourceRevision: 'b'.repeat(40),
        imageDigest: digest,
        digestSource,
        sourceRevisionVerified: false,
      },
      paths,
    } as StageContext;
    const build = {
      schema_version: 'premortem.build.v1',
      run_id: 'test-run',
      source: { commit: 'b'.repeat(40) },
      image: {
        reference: `localhost:15002/guestbook@${digest}`,
        registry_digest: digest,
        registry_link_verified: true,
        source_build_link_verified: true,
      },
    };
    writeFileSync(
      join(manifestDir, 'build_manifest.json'),
      JSON.stringify(build),
    );
    const config = {
      get: (key: string) =>
        ({
          'backend.parityBuildManifestDirectory': join(root, 'manifests'),
          'backend.repoRoot': root,
          'backend.parityPythonCommand': 'python3',
          'backend.parityTimeoutMs': 1000,
          'backend.parityPlatforms': 'linux/amd64,linux/arm64',
          'backend.parityBuilder': '',
        })[key],
    } as ConfigService<BackendConfig, true>;
    const checkout = { checkout: vi.fn() };
    const moduleRef = {
      get: (type: unknown) => {
        expect(type).toBe(GithubSourceCheckoutService);
        return checkout;
      },
    } as unknown as ModuleRef;
    const deployments = { findActive: vi.fn().mockReturnValue(undefined) };
    const applications = {
      getView: vi.fn().mockReturnValue({
        healthCheck: { path: '/healthz', timeoutSeconds: 5 },
      }),
    };
    const inputs = new ParityInputService();
    const create = (run: ReturnType<typeof vi.fn>) =>
      new ParityTestStage(
        config,
        { run },
        moduleRef,
        inputs,
        deployments as never,
        applications as never,
      );
    return {
      root,
      context,
      config,
      build,
      manifestDir,
      digest,
      checkout,
      deployments,
      create,
    };
  }

  it('rejects a prebuilt manifest from another run before parity execution', async () => {
    const { context, build, manifestDir, create } = setup();
    writeFileSync(
      join(manifestDir, 'build_manifest.json'),
      JSON.stringify({ ...build, run_id: 'another-run' }),
    );
    const run = successfulRunner(context);
    const result = await create(run).run(context);
    expect(result.status).toBe('failed');
    expect(result.deploymentPatch).toBeUndefined();
    expect(
      run.mock.calls.some((call) => call[0].args.includes('backend-test')),
    ).toBe(false);
  });

  it.each([true, false])(
    'verifies source identity only after completed parity (passed=%s)',
    async (passed) => {
      const { context, digest, create } = setup();
      const run = successfulRunner(context, passed);
      const result = await create(run).run(context);

      expect(result.status).toBe('succeeded');
      expect(result.summary).toMatchObject({
        stub: false,
        test_passed: passed,
        parity_baseline: {
          mode: 'replay',
          changed: false,
          candidate_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(result.deploymentPatch).toEqual({
        imageDigest: digest,
        digestSource: 'registry',
        sourceRevisionVerified: true,
      });
    },
  );

  it('uses health-only verification when the first revision has no parity files', async () => {
    const { context, create } = setup('registry', false);
    const run = successfulRunner(context);
    const result = await create(run).run(context);
    const request = JSON.parse(
      readFileSync(
        join(context.paths.root, 'test-work', 'parity-request.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    expect(result.status).toBe('succeeded');
    expect(request.format).toBe('premortem-backend-health-v1');
    expect(request).not.toHaveProperty('record');
    expect(result.summary).toMatchObject({
      parity_baseline: { mode: 'health', changed: false },
    });
  });

  it('replays the active baseline and marks a candidate baseline change', async () => {
    const { root, context, checkout, deployments, create } = setup();
    context.application.sourcePath = 'https://github.com/octo/private.git';
    const candidate = join(root, 'candidate');
    const active = join(root, 'active');
    mkdirSync(candidate);
    mkdirSync(active);
    writeParity(candidate, 'candidate');
    writeParity(active, 'active');
    deployments.findActive.mockReturnValue({
      id: 'active-deployment',
      sourceRevision: 'c'.repeat(40),
    });
    checkout.checkout
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(active);
    const run = successfulRunner(context);

    const result = await create(run).run(context);
    const testResult = JSON.parse(
      readFileSync(join(context.paths.test, 'test_result.json'), 'utf8'),
    ) as { facts: { parity_baseline: Record<string, unknown> } };
    const request = JSON.parse(
      readFileSync(
        join(context.paths.root, 'test-work', 'parity-request.json'),
        'utf8',
      ),
    ) as { record: string };

    expect(result.status).toBe('succeeded');
    expect(request.record).toBe(
      join(active, '.hibiscus', 'parity', 'session.jsonl'),
    );
    expect(testResult.facts.parity_baseline).toMatchObject({
      mode: 'replay',
      changed: true,
      active_source_revision: 'c'.repeat(40),
      active_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidate_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('checks out the exact GitHub revision before build and parity', async () => {
    const { root, context, build, checkout, create } = setup('placeholder');
    context.application.sourcePath = 'https://github.com/octo/private.git';
    const checkedOut = join(root, 'github-checkout');
    mkdirSync(checkedOut);
    writeParity(checkedOut, 'candidate');
    const destination = join(context.paths.root, 'test-work', 'source');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'stale'), 'old checkout');
    checkout.checkout.mockImplementation(
      (_applicationId: string, _revision: string, checkoutPath: string) => {
        expect(checkoutPath).toBe(destination);
        expect(existsSync(checkoutPath)).toBe(false);
        return Promise.resolve(checkedOut);
      },
    );
    const run = successfulRunner(context, true, build);

    const result = await create(run).run(context);

    expect(result.status).toBe('succeeded');
    expect(checkout.checkout).toHaveBeenCalledWith(
      context.application.id,
      context.deployment.sourceRevision,
      destination,
    );
    const buildCall = run.mock.calls.find((call) =>
      call[0].args.includes('build'),
    )?.[0];
    expect(buildCall?.args).toContain(checkedOut);
  });

  it('rejects artifacts checked against the old placeholder and accepts the verified image identity', () => {
    const { context, digest } = setup();
    writeFileSync(
      join(context.paths.test, 'test_result.json'),
      JSON.stringify({
        run_id: 'test-run',
        digest,
        source_revision: 'b'.repeat(40),
      }),
    );
    const execution = {
      id: 'stage',
      deploymentId: 'test-run',
      stage: 'test',
    } as StageExecution;
    const artifacts = new DeploymentArtifactService();
    expect(
      artifacts.capture(context.paths, execution, {
        ...context.deployment,
        imageDigest: `sha256:${'c'.repeat(64)}`,
      }).error,
    ).toContain('does not match');
    expect(
      artifacts.capture(context.paths, execution, context.deployment).error,
    ).toBeUndefined();
  });

  function successfulRunner(
    context: StageContext,
    passed = true,
    build?: Record<string, unknown>,
  ) {
    return vi
      .fn()
      .mockImplementation((spec: { command: string; args: string[] }) => {
        if (spec.command === 'git') {
          return Promise.resolve(result(context.deployment.sourceRevision));
        }
        if (spec.args.includes('build')) {
          const buildDir = join(context.paths.root, 'test-work', 'build');
          mkdirSync(buildDir, { recursive: true });
          writeFileSync(
            join(buildDir, 'build_manifest.json'),
            JSON.stringify(build),
          );
        } else if (spec.args.includes('backend-test')) {
          mkdirSync(join(context.paths.test, 'parity'), { recursive: true });
          writeFileSync(
            join(context.paths.test, 'parity', 'build_manifest.json'),
            '{}',
          );
          writeFileSync(
            join(context.paths.test, 'stage_result.json'),
            JSON.stringify({
              status: 'succeeded',
              exitCode: 0,
              summary: { stub: false, test_passed: passed },
            }),
          );
          writeFileSync(
            join(context.paths.test, 'test_result.json'),
            JSON.stringify({
              run_id: context.deployment.id,
              app: context.application.name,
              source_revision: context.deployment.sourceRevision,
              digest: context.deployment.imageDigest,
              passed,
              match: { total: 1, matched: passed ? 1 : 0 },
              failures: [],
              facts: {},
            }),
          );
        }
        return Promise.resolve(result(''));
      });
  }

  function result(stdout: string) {
    return {
      code: 0,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false,
    };
  }

  function writeParity(source: string, marker: string): void {
    const directory = join(source, '.hibiscus', 'parity');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'session.jsonl'),
      `${JSON.stringify({ index: 1, marker })}\n`,
    );
    writeFileSync(
      join(directory, 'noise.json'),
      `${JSON.stringify({ rules: [], marker })}\n`,
    );
  }
});
