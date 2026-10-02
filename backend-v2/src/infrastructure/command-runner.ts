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
}

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
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.setEncoding('utf8').on('data', (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding('utf8').on('data', (data: string) => {
        stderr += data;
      });
      const timer = spec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, spec.timeoutMs)
        : undefined;
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, timedOut });
      });
    });
  }
}
