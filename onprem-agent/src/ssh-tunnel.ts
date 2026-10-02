import { spawn, type ChildProcess } from "node:child_process";
import type { AgentConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { BackendAgentClient, SshForward } from "./types.js";

type ProcessSpawner = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "ignore", "pipe"] },
) => ChildProcess;

export class SshTunnel {
  private process?: ChildProcess;
  private signature?: string;
  private stopping = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly backend: BackendAgentClient,
    private readonly state: StateStore,
    private readonly spawnProcess: ProcessSpawner = spawn,
  ) {}

  async start(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.reconcile();
      } catch (error) {
        console.error(
          `[ssh-tunnel] ${error instanceof Error ? error.message : "Unable to reconcile SSH forwards"}`,
        );
      }
      await this.wait(this.config.sshForwardPollIntervalMs);
    }
  }

  stop(): void {
    this.stopping = true;
    this.stopProcess();
  }

  private async reconcile(): Promise<void> {
    const requested = await this.backend.forwards();
    const state = await this.state.read();
    const allowedPorts = new Set(
      Object.values(state.containers).map((container) => container.host_port),
    );
    const forwards = selectSshForwards(requested, allowedPorts);
    const signature = JSON.stringify(forwards);
    if (this.process && signature === this.signature) return;
    if (this.process) {
      this.stopProcess();
      return;
    }
    if (forwards.length === 0) {
      this.signature = signature;
      return;
    }
    this.startProcess(forwards, signature);
  }

  private startProcess(forwards: SshForward[], signature: string): void {
    const process = this.spawnProcess(
      this.config.sshCommand,
      sshArguments(this.config, forwards),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.process = process;
    this.signature = signature;
    process.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.error(`[ssh-tunnel] ${message}`);
    });
    process.once("error", (error) => {
      console.error(`[ssh-tunnel] ${error.message}`);
    });
    process.once("close", (code, signal) => {
      if (this.process !== process) return;
      this.process = undefined;
      this.signature = undefined;
      if (!this.stopping) {
        console.error(
          `[ssh-tunnel] SSH exited (${signal ?? code ?? "unknown"})`,
        );
      }
    });
  }

  private stopProcess(): void {
    const process = this.process;
    this.process = undefined;
    this.signature = undefined;
    if (process && process.exitCode === null && process.signalCode === null) {
      process.kill("SIGTERM");
    }
  }

  private wait(delay: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export function sshArguments(
  config: AgentConfig,
  forwards: SshForward[],
): string[] {
  return [
    "-N",
    "-T",
    "-p",
    String(config.sshPort),
    "-i",
    config.sshIdentityFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${config.sshKnownHostsFile}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ServerAliveInterval=${config.sshServerAliveIntervalSeconds}`,
    "-o",
    `ServerAliveCountMax=${config.sshServerAliveCountMax}`,
    ...forwards.flatMap((forward) => [
      "-R",
      `127.0.0.1:${forward.gateway_port}:127.0.0.1:${forward.local_port}`,
    ]),
    `${config.sshUser}@${config.sshHost}`,
  ];
}

export function selectSshForwards(
  requested: SshForward[],
  allowedLocalPorts: ReadonlySet<number>,
): SshForward[] {
  return requested
    .filter((forward) => allowedLocalPorts.has(forward.local_port))
    .sort((left, right) => left.gateway_port - right.gateway_port);
}
