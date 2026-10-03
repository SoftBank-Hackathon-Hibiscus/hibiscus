/** Backend PR #20의 CommandRunner/StageOutcome 형태에 맞춘 호출부. 등록·배포 코드는 호출하지 않는다. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface TestRequest {
  format: 'premortem-backend-test-v1';
  run_id: string;
  app: string;
  source_revision: string;
  digest: string;
  build_manifest: string;
  record: string;
  noise: string;
  port?: number;
  health_path?: string;
  health_timeout?: number;
  after?: number[];
  /** 검증 컨테이너 전용. 운영 환경변수를 전달하지 않는다. */
  environment?: Record<string, string>;
}

interface Command {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}
interface CommandResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean; }
interface StageOutcome {
  status: 'succeeded' | 'failed';
  exitCode: number | null;
  artifacts: Record<string, string>;
  summary?: unknown;
  error?: string;
}

export async function runParityTestStage(options: {
  repoRoot: string;
  pythonCommand: string;
  artifactRoot: string;
  outputDir: string;
  request: TestRequest;
  timeoutMs?: number;
}, runner: { run(command: Command): Promise<CommandResult> }): Promise<StageOutcome> {
  const { request } = options;
  const root = resolve(options.artifactRoot);
  const output = resolve(options.outputDir);
  const underRoot = relative(root, output);
  if (!underRoot || isAbsolute(underRoot) || underRoot.startsWith('..')) {
    return { status: 'failed', exitCode: 1, artifacts: {}, error: 'Test output must be under the deployment artifact root' };
  }
  // 요청은 테스트 결과 폴더 밖에 둔다. CLI는 새 폴더 또는 비어 있는 단계 폴더만 받는다.
  const requestFile = output + '.request.json';
  try {
    mkdirSync(dirname(requestFile), { recursive: true });
    writeFileSync(requestFile, JSON.stringify(request, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    const result = await runner.run({
      command: options.pythonCommand,
      args: ['-m', 'premortem', 'backend-test', '--request', requestFile, '--out-dir', output, '--json'],
      cwd: join(resolve(options.repoRoot), 'parity'),
      timeoutMs: options.timeoutMs ?? 1_200_000,
    });
    if (result.timedOut || result.code !== 0) {
      return { status: 'failed', exitCode: result.code, artifacts: {},
        error: result.timedOut ? 'Parity test timed out' : 'Parity test or policy adapter failed' };
    }
    const stage = JSON.parse(readFileSync(join(output, 'stage_result.json'), 'utf8'));
    const test = JSON.parse(readFileSync(join(output, 'test_result.json'), 'utf8'));
    if (stage.status !== 'succeeded' || stage.exitCode !== 0 || stage.summary?.stub !== false
        || typeof test.passed !== 'boolean' || stage.summary?.test_passed !== test.passed
        || ['run_id', 'app', 'source_revision', 'digest'].some(key =>
          test[key] !== request[key as keyof TestRequest])) {
      return { status: 'failed', exitCode: 1, artifacts: {}, error: 'Test artifacts do not match this deployment' };
    }
    const artifacts: Record<string, string> = {};
    for (const [name, file] of Object.entries({ test_result: 'test_result.json',
      handoff: 'parity/parity_handoff.json', raw_result: 'parity/result.json',
      diagnostics: 'parity/verified.diagnostics.json' })) {
      artifacts[name] = relative(root, join(output, file)).split('\\').join('/');
    }
    // failed tests are input to policy. A completed test stage does not grant deployment permission.
    return { status: 'succeeded', exitCode: 0, artifacts, summary: stage.summary };
  } catch {
    return { status: 'failed', exitCode: 1, artifacts: {}, error: 'Unable to run or read the parity test stage' };
  }
}
