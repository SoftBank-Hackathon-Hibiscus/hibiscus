import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import { GithubSourceCheckoutService } from '../../github/github-source-checkout.service.js';
import {
  CommandRunner,
  type CommandSpec,
} from '../../infrastructure/command-runner.js';
import type { StageContext, StageOutcome } from '../types/deployment.type.js';

const absoluteFile = z
  .string()
  .min(1)
  .refine(isAbsolute, 'An absolute path is required');
const inputSchema = z
  .object({
    record: absoluteFile,
    noise: absoluteFile,
    after: z.array(z.number().int().positive()).default([]),
    health_path: z
      .string()
      .regex(/^\/\S*$/)
      .default('/healthz'),
    health_timeout: z.number().positive().default(30),
    // Prebuilt runs use <directory>/<deployment.id>/build_manifest.json.
    build_manifest_directory: absoluteFile.optional(),
  })
  .strict();
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

/** Review implementation for connecting #21/#24 to the Backend test stage. */
@Injectable()
export class ParityTestStage {
  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly runner: CommandRunner,
    private readonly moduleRef: ModuleRef,
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
      const inputFile = this.config.get('backend.parityInputsFile', {
        infer: true,
      });
      if (!isAbsolute(inputFile))
        throw new Error('PARITY_INPUTS_FILE must be an absolute path');
      const inputs = z
        .record(z.string(), inputSchema)
        .parse(JSON.parse(readFileSync(inputFile, 'utf8')));
      const input = inputs[application.slug];
      if (!input)
        throw new Error('Parity inputs are missing for this application slug');
      for (const file of [input.record, input.noise]) {
        if (!existsSync(file))
          throw new Error('Parity baseline file is missing');
      }
      const repoRoot = this.config.get('backend.repoRoot', { infer: true });
      const python = this.config.get('backend.parityPythonCommand', {
        infer: true,
      });
      const timeoutMs = this.config.get('backend.parityTimeoutMs', {
        infer: true,
      });
      const run = async (spec: CommandSpec) => {
        const result = await this.runner.run(spec);
        if (result.timedOut || result.code !== 0) {
          throw new Error(
            result.timedOut
              ? 'Parity command timed out'
              : 'Parity build or test command failed',
          );
        }
        return result;
      };
      const command = {
        command: python,
        cwd: join(repoRoot, 'parity'),
        timeoutMs,
      };
      let manifestPath: string;
      if (deployment.digestSource === 'registry') {
        if (!input.build_manifest_directory)
          throw new Error(
            'A prebuilt digest requires its build manifest directory',
          );
        manifestPath = join(
          input.build_manifest_directory,
          deployment.id,
          'build_manifest.json',
        );
      } else {
        const sourcePath = await this.sourcePath(
          application.id,
          application.sourcePath,
          deployment.sourceRevision,
          join(paths.root, 'source'),
        );
        const revision = await run({
          command: 'git',
          cwd: sourcePath,
          args: ['rev-parse', '--verify', 'HEAD^{commit}'],
          timeoutMs: 30_000,
        });
        if (revision.stdout.trim() !== deployment.sourceRevision) {
          throw new Error(
            'App checkout does not match the requested source SHA',
          );
        }
        const buildDir = join(paths.root, 'build');
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
        await run({ ...command, args });
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
        format: 'premortem-backend-test-v1',
        run_id: deployment.id,
        app: application.name,
        source_revision: deployment.sourceRevision,
        digest,
        build_manifest: manifestPath,
        record: input.record,
        noise: input.noise,
        after: input.after,
        port: application.containerPort,
        health_path: input.health_path,
        health_timeout: input.health_timeout,
      };
      const requestPath = join(paths.root, 'parity-request.json');
      writeFileSync(requestPath, JSON.stringify(request, null, 2) + '\n', {
        flag: 'wx',
      });
      await run({
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
      });
      const stage = stageSchema.parse(
        JSON.parse(readFileSync(join(paths.test, 'stage_result.json'), 'utf8')),
      );
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
        summary: stage.summary,
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
        error:
          error instanceof Error
            ? error.message
            : 'Unable to run registry parity',
      };
    }
  }

  private async sourcePath(
    applicationId: string,
    configuredPath: string,
    sourceRevision: string,
    destination: string,
  ): Promise<string> {
    if (
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
        configuredPath,
      )
    ) {
      return configuredPath;
    }
    return this.moduleRef
      .get(GithubSourceCheckoutService, { strict: false })
      .checkout(applicationId, sourceRevision, destination);
  }
}
