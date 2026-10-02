import { execFile } from "node:child_process";

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(command: string, args: string[]): Promise<CommandOutput>;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(message);
  }
}

export class CommandRunner implements CommandExecutor {
  constructor(private readonly timeoutMs: number) {}

  run(command: string, args: string[]): Promise<CommandOutput> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new CommandError(
                `${command} command failed`,
                stderr.trim(),
                error.code ?? null,
              ),
            );
            return;
          }
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        },
      );
    });
  }
}
