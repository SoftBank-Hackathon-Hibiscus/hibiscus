import type { ConfigService } from '@nestjs/config';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { DatabaseService } from '../../database/database.service.js';
import {
  CommandRunner,
  type CommandResult,
  type CommandSpec,
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
      '-c',
      'credential.helper=',
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

  it('does not persist the OAuth token through an inherited credential helper', async () => {
    const root = temporaryDirectory();
    const repositoryRoot = join(root, 'repositories');
    const remote = join(repositoryRoot, 'octo', 'private.git');
    const source = join(root, 'source-repository');
    const destination = join(root, 'checkout');
    const credentialStore = join(root, 'stored-credentials');
    const globalConfig = join(root, 'gitconfig');
    mkdirSync(join(repositoryRoot, 'octo'), { recursive: true });
    git(['init', '--bare', remote]);
    git(['init', source]);
    git(['-C', source, 'config', 'user.name', 'Checkout Test']);
    git(['-C', source, 'config', 'user.email', 'checkout@example.invalid']);
    writeFileSync(join(source, 'app.txt'), 'verified source\n');
    git(['-C', source, 'add', 'app.txt']);
    git(['-C', source, 'commit', '-m', 'test source']);
    const sourceRevision = git(['-C', source, 'rev-parse', 'HEAD']).trim();
    git(['-C', source, 'push', remote, `HEAD:refs/heads/main`]);

    const server = await authenticatedGitServer(repositoryRoot);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test Git server did not bind to a TCP port');
    }
    const previous = {
      global: process.env.GIT_CONFIG_GLOBAL,
      noSystem: process.env.GIT_CONFIG_NOSYSTEM,
      home: process.env.HOME,
    };
    try {
      git([
        'config',
        '--file',
        globalConfig,
        'credential.helper',
        `store --file=${credentialStore}`,
      ]);
      git([
        'config',
        '--file',
        globalConfig,
        `url.http://127.0.0.1:${address.port}/.insteadOf`,
        'https://github.com/',
      ]);
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      process.env.HOME = root;

      const service = checkoutService(new CommandRunner());
      await expect(
        service.checkout('application-1', sourceRevision, destination),
      ).resolves.toBe(destination);

      expect(readFileSync(join(destination, 'app.txt'), 'utf8')).toBe(
        'verified source\n',
      );
      expect(existsSync(`${destination}.credentials`)).toBe(false);
      expect(
        existsSync(credentialStore)
          ? readFileSync(credentialStore, 'utf8')
          : '',
      ).not.toContain(token);
    } finally {
      restoreEnvironment('GIT_CONFIG_GLOBAL', previous.global);
      restoreEnvironment('GIT_CONFIG_NOSYSTEM', previous.noSystem);
      restoreEnvironment('HOME', previous.home);
      await closeServer(server);
    }
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

  function git(args: string[]): string {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
  }

  function authenticatedGitServer(repositoryRoot: string): Promise<Server> {
    const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const server = createServer((request, response) => {
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Git"' });
        response.end('Authentication required');
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: repositoryRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? 'GET',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          CONTENT_LENGTH: request.headers['content-length'] ?? '',
          REMOTE_USER: 'x-access-token',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
      request.pipe(child.stdin);
      child.on('close', (code) => {
        if (code !== 0) {
          response.writeHead(500);
          response.end(Buffer.concat(errors));
          return;
        }
        const body = Buffer.concat(output);
        const separator = body.indexOf('\r\n\r\n');
        if (separator < 0) {
          response.writeHead(500);
          response.end('Invalid Git CGI response');
          return;
        }
        const headers = body.subarray(0, separator).toString('utf8');
        let status = 200;
        const responseHeaders: Record<string, string> = {};
        for (const line of headers.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon < 0) continue;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') {
            status = Number.parseInt(value, 10);
          } else {
            responseHeaders[name] = value;
          }
        }
        response.writeHead(status, responseHeaders);
        response.end(body.subarray(separator + 4));
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
