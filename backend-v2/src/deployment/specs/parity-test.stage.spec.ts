import { ConfigService } from '@nestjs/config';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

describe('registry parity connection', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0))
      rmSync(path, { recursive: true, force: true });
  });
  function setup(digestSource: 'registry' | 'placeholder' = 'registry') {
    const root = mkdtempSync(join(tmpdir(), 'parity-stage-'));
    directories.push(root);
    const paths = new DeploymentPaths(root, 'test-run');
    paths.ensure();
    const manifestDir = join(root, 'manifests', 'test-run');
    mkdirSync(manifestDir, { recursive: true });
    const inputsFile = join(root, 'inputs.json');
    for (const name of ['record', 'noise'])
      writeFileSync(join(root, name), '{}');
    writeFileSync(
      inputsFile,
      JSON.stringify({
        guestbook: {
          record: join(root, 'record'),
          noise: join(root, 'noise'),
          build_manifest_directory: join(root, 'manifests'),
        },
      }),
    );
    const digest = `sha256:${'a'.repeat(64)}`;
    const context = {
      application: {
        name: 'guestbook',
        slug: 'guestbook',
        sourcePath: root,
        imageRepo: 'localhost:15002/guestbook',
        containerPort: 8080,
      },
      deployment: {
        id: 'test-run',
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
          'backend.parityInputsFile': inputsFile,
          'backend.repoRoot': root,
          'backend.parityPythonCommand': 'python3',
          'backend.parityTimeoutMs': 1000,
        })[key],
    } as ConfigService<BackendConfig, true>;
    return { root, context, config, build, manifestDir, digest };
  }
  it('rejects a prebuilt manifest from another run before executing a command', async () => {
    const { context, config, build, manifestDir } = setup();
    writeFileSync(
      join(manifestDir, 'build_manifest.json'),
      JSON.stringify({ ...build, run_id: 'another-run' }),
    );
    const run = vi.fn();
    const result = await new ParityTestStage(config, { run }).run(context);
    expect(result.status).toBe('failed');
    expect(result.deploymentPatch).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'verifies source identity only after completed parity (passed=%s)',
    async (passed) => {
      const { context, config, digest } = setup();
      const run = vi.fn().mockImplementation(() => {
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
            run_id: 'test-run',
            app: 'guestbook',
            source_revision: 'b'.repeat(40),
            digest,
            passed,
          }),
        );
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
        });
      });
      const result = await new ParityTestStage(config, { run }).run(context);
      expect(result.status).toBe('succeeded');
      expect(result.summary).toMatchObject({
        stub: false,
        test_passed: passed,
      });
      expect(result.deploymentPatch).toEqual({
        imageDigest: digest,
        digestSource: 'registry',
        sourceRevisionVerified: true,
      });
    },
  );
  it('does not verify the source after a timeout', async () => {
    const { context, config } = setup();
    const run = vi.fn().mockResolvedValue({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    });
    const result = await new ParityTestStage(config, { run }).run(context);
    expect(result.status).toBe('failed');
    expect(result.deploymentPatch).toBeUndefined();
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
});
