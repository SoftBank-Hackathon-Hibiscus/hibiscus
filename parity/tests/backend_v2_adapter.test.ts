import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runParityTestStage, type TestRequest } from '../integrations/backend_v2.ts';

test('backend treats completed failed tests as policy input, with run-scoped paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parity-backend-'));
  try {
    const request: TestRequest = { format: 'premortem-backend-test-v1', run_id: 'run-1', app: 'app',
      source_revision: 'a'.repeat(40), digest: 'sha256:' + 'b'.repeat(64),
      build_manifest: '/build/build_manifest.json', record: '/records/session.jsonl', noise: '/records/noise.json' };
    const options = { repoRoot: root, artifactRoot: root, outputDir: join(root, 'test'), pythonCommand: 'python3', request };
    const runner = { async run(command: { command: string; args: string[]; cwd: string }) {
      assert.equal(command.command, 'python3');
      assert.deepEqual(command.args.slice(0, 3), ['-m', 'premortem', 'backend-test']);
      assert.equal(command.cwd, join(root, 'parity'));
      mkdirSync(options.outputDir);
      writeFileSync(join(options.outputDir, 'test_result.json'), JSON.stringify({ ...request, passed: false }));
      writeFileSync(join(options.outputDir, 'stage_result.json'), JSON.stringify({ status: 'succeeded', exitCode: 0,
        summary: { stub: false, test_passed: false } }));
      return { code: 0, stdout: '{}', stderr: '', timedOut: false };
    } };
    const outcome = await runParityTestStage(options, runner);
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.artifacts.test_result, 'test/test_result.json');
    assert.equal((outcome.summary as { test_passed: boolean }).test_passed, false);
    // A retry cannot consume the previous run's request and artifacts.
    assert.equal((await runParityTestStage(options, runner)).status, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('backend rejects timeout and mismatched image identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'parity-backend-'));
  try {
    const request: TestRequest = { format: 'premortem-backend-test-v1', run_id: 'run-1', app: 'app',
      source_revision: 'a'.repeat(40), digest: 'sha256:' + 'b'.repeat(64),
      build_manifest: '/build/build_manifest.json', record: '/records/session.jsonl', noise: '/records/noise.json' };
    for (const mode of ['timeout', 'identity']) {
      const outputDir = join(root, mode);
      const result = await runParityTestStage({ repoRoot: root, artifactRoot: root, outputDir, pythonCommand: 'python3', request },
        { async run() {
          if (mode === 'timeout') return { code: null, stdout: '', stderr: '', timedOut: true };
          mkdirSync(outputDir);
          writeFileSync(join(outputDir, 'test_result.json'), JSON.stringify({ ...request, digest: 'wrong', passed: true }));
          writeFileSync(join(outputDir, 'stage_result.json'), JSON.stringify({ status: 'succeeded', exitCode: 0,
            summary: { stub: false, test_passed: true } }));
          return { code: 0, stdout: '{}', stderr: '' };
        } });
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.artifacts, {});
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
