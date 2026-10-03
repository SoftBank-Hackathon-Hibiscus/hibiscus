import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import type { BackendConfig } from '../config/configs/backend.config.js';

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated?: boolean;
}

// Keep the end (CLI result/error JSON), without allowing build logs to exhaust the worker.
export const MAX_COMMAND_OUTPUT_CHARS = 1024 * 1024;

export const npmCommand = (config: ConfigService<BackendConfig, true>) =>
  config.get('backend.npmCommand', { infer: true });

export function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

@Injectable()
export class CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let outputTruncated = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const append = (current: string, data: string) => {
        const next = current + data;
        if (next.length > MAX_COMMAND_OUTPUT_CHARS) outputTruncated = true;
        return next.slice(-MAX_COMMAND_OUTPUT_CHARS);
      };
      child.stdout.setEncoding('utf8').on('data', (data: string) => {
        stdout = append(stdout, data);
      });
      child.stderr.setEncoding('utf8').on('data', (data: string) => {
        stderr = append(stderr, data);
      });
      const killTree = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const killer = spawn(
            'taskkill',
            ['/pid', String(child.pid), '/T', '/F'],
            {
              windowsHide: true,
              shell: false,
              stdio: 'ignore',
            },
          );
          killer.on('error', () => {
            child.kill(signal);
          });
          return;
        }
        try {
          // Python/npm may have Docker or other subprocesses holding the output pipes open.
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            child.kill(signal);
        }
      };
      const timer = spec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killTree('SIGTERM');
            forceKillTimer = setTimeout(() => killTree('SIGKILL'), 1000);
          }, spec.timeoutMs)
        : undefined;
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (timedOut) killTree('SIGKILL');
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({ code, signal, stdout, stderr, timedOut, outputTruncated });
      });
    });
  }
}
