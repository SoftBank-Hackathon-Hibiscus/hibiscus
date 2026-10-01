/**
 * 외부 명령 실행을 감싼다. 단계 구현은 이 인터페이스만 보고, 테스트에서는 가짜 실행기를 주입한다.
 * Windows 에서 npm 은 npm.cmd 라서 셸을 거쳐야 실행된다 (Node 는 .cmd 를 셸 없이 spawn 하지 않는다).
 */
import { spawn } from "node:child_process";

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  /** process.env 위에 덮어쓸 값 */
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

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

/** 플랫폼에 맞는 npm 실행 파일 이름 */
export function npmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function needsShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/** cmd.exe 로 넘길 때 공백·특수문자가 있는 인자를 큰따옴표로 감싼다 */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** stdout 마지막 비어 있지 않은 줄을 JSON 으로 읽는다 (npm 이 앞에 찍는 명령 echo 를 건너뛴다) */
export function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class RealCommandRunner implements CommandRunner {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  run(spec: CommandSpec): Promise<CommandResult> {
    // .cmd 는 cmd.exe 를 거쳐야 한다. 인자를 직접 따옴표 처리해 한 줄로 만들고 verbatim 으로 넘긴다
    const viaCmd = needsShell(spec.command, this.platform);
    const command = viaCmd ? "cmd.exe" : spec.command;
    const args = viaCmd ? ["/d", "/s", "/c", `"${[spec.command, ...spec.args].map(quoteForCmd).join(" ")}"`] : spec.args;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        windowsVerbatimArguments: viaCmd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer =
        spec.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, spec.timeoutMs)
          : undefined;
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ code, signal, stdout, stderr, timedOut });
      });
    });
  }
}
