import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig } from '../config/configs/backend.config.js';
import { DatabaseService } from '../database/database.service.js';
import { githubApplicationLinks } from '../database/schema.js';
import {
  CommandRunner,
  type CommandSpec,
} from '../infrastructure/command-runner.js';
import { GithubConnectionService } from './github-connection.service.js';

const fullSha = /^[a-f0-9]{40}$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

@Injectable()
export class GithubSourceCheckoutService {
  constructor(
    private readonly database: DatabaseService,
    private readonly connections: GithubConnectionService,
    private readonly commands: CommandRunner,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  async checkout(
    applicationId: string,
    sourceRevision: string,
    destination: string,
  ): Promise<string> {
    if (!fullSha.test(sourceRevision)) {
      throw new Error('GitHub checkout requires a full commit SHA');
    }
    const link = this.database.db
      .select()
      .from(githubApplicationLinks)
      .where(eq(githubApplicationLinks.applicationId, applicationId))
      .get();
    if (!link?.active) {
      throw new Error('GitHub application link is not active');
    }
    if (!repositoryName.test(link.repositoryFullName)) {
      throw new Error('GitHub repository name is invalid');
    }
    if (existsSync(destination)) {
      throw new Error('GitHub checkout destination already exists');
    }

    const credentials = `${destination}.credentials`;
    mkdirSync(destination, { mode: 0o700 });
    const tokenFile = join(credentials, 'token');
    const askpassFile = join(credentials, 'askpass.sh');
    try {
      mkdirSync(credentials, { mode: 0o700 });
      const token = await this.connections.accessToken(link.userId);
      writeFileSync(tokenFile, token, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      writeFileSync(
        askpassFile,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  *Username*) printf "%s\\n" "x-access-token" ;;',
          '  *Password*) cat "$HIBISCUS_GITHUB_TOKEN_FILE" ;;',
          '  *) exit 1 ;;',
          'esac',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o700, flag: 'wx' },
      );
      chmodSync(askpassFile, 0o700);
      const environment = {
        ...process.env,
        GIT_ASKPASS: askpassFile,
        GIT_ASKPASS_REQUIRE: 'force',
        GIT_TERMINAL_PROMPT: '0',
        HIBISCUS_GITHUB_TOKEN_FILE: tokenFile,
      };
      const run = async (args: string[], authenticated = false) => {
        const spec: CommandSpec = {
          command: 'git',
          args,
          cwd: destination,
          timeoutMs: this.config.get('backend.githubCheckoutTimeoutMs', {
            infer: true,
          }),
          ...(authenticated ? { env: environment } : {}),
        };
        const result = await this.commands.run(spec);
        if (result.timedOut || result.code !== 0) {
          throw new Error(
            result.timedOut
              ? 'GitHub source checkout timed out'
              : 'GitHub source checkout failed',
          );
        }
        return result.stdout.trim();
      };

      await run(['init', '--quiet', '.']);
      await run([
        'remote',
        'add',
        'origin',
        `https://github.com/${link.repositoryFullName}.git`,
      ]);
      await run(
        [
          '-c',
          'protocol.version=2',
          'fetch',
          '--quiet',
          '--depth=1',
          '--no-tags',
          'origin',
          sourceRevision,
        ],
        true,
      );
      await run(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      const checkedOut = await run(['rev-parse', '--verify', 'HEAD^{commit}']);
      if (checkedOut !== sourceRevision) {
        throw new Error('GitHub checkout does not match the requested commit');
      }
      return destination;
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(credentials, { recursive: true, force: true });
    }
  }
}
