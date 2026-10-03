import { CommandRunner, MAX_COMMAND_OUTPUT_CHARS } from '../command-runner.js';
import { diagnosticTail } from '../command-diagnostics.js';

describe('command execution diagnostics', () => {
  it('redacts credentials before taking the final lines', () => {
    const secret = 'sensitive-value-123';
    const output = [
      `Authorization: Bearer ${secret}`,
      `COSIGN_PASSWORD="${secret}"`,
      `{"access_token":"${secret}"}`,
      `https://user:${secret}@registry.example/path`,
      '-----BEGIN PRIVATE KEY-----',
      ...Array.from({ length: 30 }, () => secret),
      '-----END PRIVATE KEY-----',
      'BUILD_IDENTITY_INVALID',
    ].join('\n');
    const tail = diagnosticTail(output);
    expect(tail).not.toContain(secret);
    expect(tail).toContain('[REDACTED PRIVATE KEY]');
    expect(tail).toMatch(/BUILD_IDENTITY_INVALID$/);
  });

  it('keeps bounded output and the final CLI result', async () => {
    const result = await new CommandRunner().run({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write('x'.repeat(${MAX_COMMAND_OUTPUT_CHARS + 100})); process.stdout.write('\\n{"done":true}'); process.stderr.write('y'.repeat(${MAX_COMMAND_OUTPUT_CHARS + 100}));`,
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBe(MAX_COMMAND_OUTPUT_CHARS);
    expect(result.stderr.length).toBe(MAX_COMMAND_OUTPUT_CHARS);
    expect(result.stdout).toMatch(/\{"done":true\}$/);
  });

  it.skipIf(process.platform === 'win32')(
    'kills descendants holding pipes open after a timeout',
    async () => {
      const childScript = `process.on('SIGTERM',()=>{}); console.log('descendant-ready'); setInterval(()=>{},1000)`;
      const parentScript = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
      const result = await new CommandRunner().run({
        command: process.execPath,
        args: ['-e', parentScript],
        cwd: process.cwd(),
        timeoutMs: 500,
      });
      expect(result.stdout).toContain('descendant-ready');
      expect(result.timedOut).toBe(true);
      expect(result.code).not.toBe(0);
      expect(result.signal).toBe('SIGKILL');
    },
    5000,
  );

  it('rejects an unavailable executable', async () => {
    // POSIX emits a spawn error; Windows' shell reports a nonzero exit instead.
    if (process.platform === 'win32') return;
    await expect(
      new CommandRunner().run({
        command: '/nonexistent/hibiscus-command',
        args: [],
        cwd: process.cwd(),
        timeoutMs: 500,
      }),
    ).rejects.toThrow();
  });
});
