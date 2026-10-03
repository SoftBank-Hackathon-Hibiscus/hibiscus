import type { ConfigService } from '@nestjs/config';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { DatabaseService } from '../../database/database.service.js';
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
} from '../../infrastructure/command-runner.js';
import type { GithubConnectionService } from '../github-connection.service.js';
import { GithubSourceCheckoutService } from '../github-source-checkout.service.js';

const revision = 'a'.repeat(40);
const token = 'github-test-token-that-must-not-leak';

describe('GithubSourceCheckoutService', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fetches the exact commit without putting the token in Git arguments', async () => {
    const root = temporaryDirectory();
    const destination = join(root, 'source');
    const calls: CommandSpec[] = [];
    const commands = {
      run: vi.fn(async (spec: CommandSpec): Promise<CommandResult> => {
        calls.push(spec);
        expect(spec.args.join(' ')).not.toContain(token);
        if (spec.args.includes('fetch')) {
          expect(
            readFileSync(
              spec.env?.HIBISCUS_GITHUB_TOKEN_FILE as string,
              'utf8',
            ),
          ).toBe(token);
          expect(Object.values(spec.env ?? {})).not.toContain(token);
        }
        return successful(spec.args[0] === 'rev-parse' ? `${revision}\n` : '');
      }),
    } as unknown as CommandRunner;
    const service = checkoutService(commands);

    await expect(
      service.checkout('application-1', revision, destination),
    ).resolves.toBe(destination);

    expect(calls.map(({ args }) => args)).toContainEqual([
      '-c',
      'protocol.version=2',
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      'origin',
      revision,
    ]);
    expect(existsSync(`${destination}.credentials`)).toBe(false);
    expect(existsSync(destination)).toBe(true);
  });

  it('removes the partial checkout and credentials after a fetch failure', async () => {
    const root = temporaryDirectory();
    const destination = join(root, 'source');
    const commands = {
      run: vi.fn((spec: CommandSpec) =>
        Promise.resolve(
          spec.args.includes('fetch')
            ? { ...successful(), code: 1, stderr: 'authentication failed' }
            : successful(),
        ),
      ),
    } as unknown as CommandRunner;
    const service = checkoutService(commands);

    await expect(
      service.checkout('application-1', revision, destination),
    ).rejects.toThrow('GitHub source checkout failed');
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.credentials`)).toBe(false);
  });

  function checkoutService(commands: CommandRunner) {
    const link = {
      applicationId: 'application-1',
      userId: 'user-1',
      repositoryFullName: 'octo/private',
      active: true,
    };
    const database = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ get: () => link }),
          }),
        }),
      },
    } as unknown as DatabaseService;
    const connections = {
      accessToken: vi.fn().mockResolvedValue(token),
    } as unknown as GithubConnectionService;
    const config = {
      get: (key: string) =>
        key === 'backend.githubCheckoutTimeoutMs' ? 120_000 : undefined,
    } as ConfigService<BackendConfig, true>;
    return new GithubSourceCheckoutService(
      database,
      connections,
      commands,
      config,
    );
  }

  function temporaryDirectory() {
    const directory = mkdtempSync(join(tmpdir(), 'github-checkout-'));
    directories.push(directory);
    return directory;
  }

  function successful(stdout = ''): CommandResult {
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false };
  }
});
