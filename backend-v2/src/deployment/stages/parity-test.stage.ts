import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ApplicationRepository } from '../../application/application.repository.js';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import { GithubSourceCheckoutService } from '../../github/github-source-checkout.service.js';
import {
  CommandRunner,
  type CommandSpec,
} from '../../infrastructure/command-runner.js';
import {
  commandDiagnostics,
  diagnosticTail,
} from '../../infrastructure/command-diagnostics.js';
import { ParityInputService } from '../parity-input.service.js';
import { DeploymentRepository } from '../deployment.repository.js';
import type { StageContext, StageOutcome } from '../types/deployment.type.js';
const buildSchema = z.object({
  schema_version: z.literal('premortem.build.v1'),
  run_id: z.string(),
  source: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }),
  image: z.object({
    reference: z.string(),
    registry_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    registry_link_verified: z.literal(true),
    source_build_link_verified: z.literal(true),
  }),
});
const testSchema = z.object({
  run_id: z.string(),
  app: z.string(),
  source_revision: z.string(),
  digest: z.string(),
  passed: z.boolean(),
});
const stageSchema = z.object({
  status: z.literal('succeeded'),
  exitCode: z.literal(0),
  summary: z
    .object({ stub: z.literal(false), test_passed: z.boolean() })
    .passthrough(),
});

class ParityCommandError extends Error {
  constructor(readonly diagnostics: ReturnType<typeof commandDiagnostics>) {
    super(
      `Parity ${diagnostics.command_phase} command ${diagnostics.timed_out ? 'timed out' : `failed (exit ${diagnostics.exit_code ?? diagnostics.signal ?? 'unknown'})`}`,
    );
  }
}

interface ParityBaselineFact {
  mode: 'replay' | 'health';
  changed: boolean;
  active_source_revision?: string;
  active_hash?: string;
  candidate_hash?: string;
  replay_hash?: string;
}

/** Review implementation for connecting #21/#24 to the Backend test stage. */
@Injectable()
export class ParityTestStage {
  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly runner: CommandRunner,
    private readonly moduleRef: ModuleRef,
    private readonly inputs: ParityInputService,
    private readonly deployments: DeploymentRepository,
    private readonly applications: ApplicationRepository,
  ) {}

  async run({
    application,
    deployment,
    paths,
  }: StageContext): Promise<StageOutcome> {
    try {
      if (!/^[a-f0-9]{40}$/.test(deployment.sourceRevision)) {
        throw new Error(
          'Registry parity requires a full 40-character source SHA',
        );
      }
      const stageWork = join(paths.root, 'test-work');
      rmSync(stageWork, { recursive: true, force: true });
      mkdirSync(stageWork, { recursive: true });
      const repoRoot = this.config.get('backend.repoRoot', { infer: true });
      const python = this.config.get('backend.parityPythonCommand', {
        infer: true,
      });
      const timeoutMs = this.config.get('backend.parityTimeoutMs', {
        infer: true,
      });
      const run = async (
        spec: CommandSpec,
        phase: 'checkout' | 'build' | 'test',
      ) => {
        const result = await this.runner.run(spec);
        if (result.timedOut || result.code !== 0) {
          throw new ParityCommandError(commandDiagnostics(phase, result));
        }
        return result;
      };
      const command = {
        command: python,
        cwd: join(repoRoot, 'parity'),
        timeoutMs,
      };
      const sourcePath = await this.sourcePath(
        application.id,
        application.sourcePath,
        deployment.sourceRevision,
        join(stageWork, 'source'),
      );
      const revision = await run(
        {
          command: 'git',
          cwd: sourcePath,
          args: ['rev-parse', '--verify', 'HEAD^{commit}'],
          timeoutMs: 30_000,
        },
        'checkout',
      );
      if (revision.stdout.trim() !== deployment.sourceRevision) {
        throw new Error('App checkout does not match the requested source SHA');
      }
      const candidateInput = this.inputs.fromSource(sourcePath);
      const active = this.deployments.findActive(application.id);
      const activeSourcePath = active
        ? await this.activeSourcePath(
            application.id,
            application.sourcePath,
            active.sourceRevision,
            deployment.sourceRevision,
            sourcePath,
            join(stageWork, 'baseline-source'),
          )
        : undefined;
      const activeInput = activeSourcePath
        ? this.inputs.fromSource(activeSourcePath)
        : undefined;
      const replayInput = active ? activeInput : candidateInput;
      const baseline: ParityBaselineFact = {
        mode: replayInput ? 'replay' : 'health',
        changed: Boolean(active && activeInput?.hash !== candidateInput?.hash),
        ...(active ? { active_source_revision: active.sourceRevision } : {}),
        ...(activeInput ? { active_hash: activeInput.hash } : {}),
        ...(candidateInput ? { candidate_hash: candidateInput.hash } : {}),
        ...(replayInput ? { replay_hash: replayInput.hash } : {}),
      };
      const applicationView = this.applications.getView(application.id);
      if (!applicationView) throw new Error('Application not found');
      let manifestPath: string;
      if (deployment.digestSource === 'registry') {
        const manifestDirectory = this.config.get(
          'backend.parityBuildManifestDirectory',
          { infer: true },
        );
        if (!manifestDirectory)
          throw new Error(
            'A prebuilt digest requires PARITY_BUILD_MANIFEST_DIRECTORY',
          );
        manifestPath = join(
          manifestDirectory,
          deployment.id,
          'build_manifest.json',
        );
      } else {
        const buildDir = join(stageWork, 'build');
        const args = [
          '-m',
          'premortem',
          'build',
          '--app',
          sourcePath,
          '--image-repo',
          application.imageRepo,
          '--run-id',
          deployment.id,
          '--out-dir',
          buildDir,
          '--platforms',
          this.config.get('backend.parityPlatforms', { infer: true }),
          '--json',
        ];
        const builder = this.config.get('backend.parityBuilder', {
          infer: true,
        });
        if (builder) args.push('--builder', builder);
        await run({ ...command, args }, 'build');
        manifestPath = join(buildDir, 'build_manifest.json');
      }
      const build = buildSchema.parse(
        JSON.parse(readFileSync(manifestPath, 'utf8')),
      );
      const digest = build.image.registry_digest;
      if (
        build.run_id !== deployment.id ||
        build.source.commit !== deployment.sourceRevision ||
        build.image.reference !== `${application.imageRepo}@${digest}` ||
        (deployment.digestSource === 'registry' &&
          deployment.imageDigest !== digest)
      ) {
        throw new Error('Build manifest does not match this deployment');
      }
      const request = {
        format: replayInput
          ? 'premortem-backend-test-v1'
          : 'premortem-backend-health-v1',
        run_id: deployment.id,
        app: application.name,
        source_revision: deployment.sourceRevision,
        digest,
        build_manifest: manifestPath,
        port: application.containerPort,
        health_path: applicationView.healthCheck.path,
        health_timeout: applicationView.healthCheck.timeoutSeconds,
        ...(replayInput
          ? { record: replayInput.record, noise: replayInput.noise }
          : {}),
      };
      const requestPath = join(stageWork, 'parity-request.json');
      writeFileSync(requestPath, JSON.stringify(request, null, 2) + '\n', {
        flag: 'wx',
      });
      await run(
        {
          ...command,
          args: [
            '-m',
            'premortem',
            'backend-test',
            '--request',
            requestPath,
            '--out-dir',
            paths.test,
            '--json',
          ],
        },
        'test',
      );
      const stage = stageSchema.parse(
        JSON.parse(readFileSync(join(paths.test, 'stage_result.json'), 'utf8')),
      );
      this.attachBaselineFact(join(paths.test, 'test_result.json'), baseline);
      const test = testSchema.parse(
        JSON.parse(readFileSync(join(paths.test, 'test_result.json'), 'utf8')),
      );
      if (
        test.run_id !== deployment.id ||
        test.app !== application.name ||
        test.source_revision !== deployment.sourceRevision ||
        test.digest !== digest ||
        test.passed !== stage.summary.test_passed
      ) {
        throw new Error('Parity result does not match this deployment');
      }
      return {
        status: 'succeeded',
        exitCode: 0,
        artifacts: {
          test_result: paths.relative(join(paths.test, 'test_result.json')),
          build_manifest: paths.relative(
            join(paths.test, 'parity/build_manifest.json'),
          ),
        },
        summary: { ...stage.summary, parity_baseline: baseline },
        deploymentPatch: {
          imageDigest: digest,
          digestSource: 'registry',
          sourceRevisionVerified: true,
        },
      };
    } catch (error) {
      return {
        status: 'failed',
        exitCode: 1,
        artifacts: {},
        ...(error instanceof ParityCommandError
          ? { summary: error.diagnostics }
          : {}),
        error:
          error instanceof Error
            ? diagnosticTail(error.message)
            : 'Unable to run registry parity',
      };
    }
  }

  private attachBaselineFact(
    testResultPath: string,
    baseline: ParityBaselineFact,
  ): void {
    const result = JSON.parse(readFileSync(testResultPath, 'utf8')) as {
      facts?: Record<string, unknown>;
    };
    result.facts = { ...result.facts, parity_baseline: baseline };
    writeFileSync(
      testResultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  }

  private async activeSourcePath(
    applicationId: string,
    configuredPath: string,
    activeRevision: string,
    candidateRevision: string,
    candidatePath: string,
    destination: string,
  ): Promise<string> {
    if (activeRevision === candidateRevision) return candidatePath;
    if (!this.isGithubSource(configuredPath)) {
      throw new Error(
        'Active parity baseline history requires a GitHub source repository',
      );
    }
    return this.moduleRef
      .get(GithubSourceCheckoutService, { strict: false })
      .checkout(applicationId, activeRevision, destination);
  }

  private async sourcePath(
    applicationId: string,
    configuredPath: string,
    sourceRevision: string,
    destination: string,
  ): Promise<string> {
    if (!this.isGithubSource(configuredPath)) {
      return configuredPath;
    }
    return this.moduleRef
      .get(GithubSourceCheckoutService, { strict: false })
      .checkout(applicationId, sourceRevision, destination);
  }

  private isGithubSource(path: string): boolean {
    return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      path,
    );
  }
}
