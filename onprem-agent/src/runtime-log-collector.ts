import { createHash } from "node:crypto";
import type { AgentConfig } from "./config.js";
import type { CommandExecutor } from "./command-runner.js";
import type { StateStore } from "./state-store.js";
import type { BackendClient } from "./backend-client.js";
export interface RuntimeLogEntry {
  id: string;
  timestamp: string;
  stream: "stdout" | "stderr";
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}
export function parseDockerLogs(
  text: string,
  stream: "stdout" | "stderr",
  secrets: string[],
): RuntimeLogEntry[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\S+)\s(.*)$/.exec(line);
      if (!match || !Number.isFinite(Date.parse(match[1]!))) return [];
      let message = match[2]!;
      for (const value of [...new Set(secrets)]
        .filter((v) => v.length >= 4)
        .sort((a, b) => b.length - a.length))
        message = message.split(value).join("[REDACTED]");
      message = message.replace(
        /((?:password|secret|token|access_key|api_key)\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
        "$1[REDACTED]",
      );
      return [
        {
          id: createHash("sha256").update(`${stream}:${line}`).digest("hex"),
          timestamp: new Date(match[1]!).toISOString(),
          stream,
          level: /\b(error|fatal|exception)\b/i.test(message)
            ? ("ERROR" as const)
            : /\bwarn(?:ing)?\b/i.test(message)
              ? ("WARN" as const)
              : ("INFO" as const),
          message: message.slice(0, 4096),
        },
      ];
    });
}
export class RuntimeLogCollector {
  private stopping = false;
  private readonly cursors = new Map<string, string>();
  constructor(
    private readonly config: AgentConfig,
    private readonly commands: CommandExecutor,
    private readonly state: StateStore,
    private readonly backend: BackendClient,
  ) {}
  stop() {
    this.stopping = true;
  }
  async start() {
    while (!this.stopping) {
      try {
        await this.collect();
      } catch {
        console.error("[agent-logs] Could not collect runtime logs");
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  async collect() {
    const state = await this.state.read();
    for (const container of Object.values(state.containers)) {
      try {
        const since =
          this.cursors.get(container.container) ??
          new Date(Date.now() - 300_000).toISOString();
        const output = await this.commands.run(this.config.dockerCommand, [
          "logs",
          "--timestamps",
          "--since",
          since,
          "--tail",
          "150",
          container.container,
        ]);
        const secrets = Object.values(container.environment ?? {});
        const entries = [
          ...parseDockerLogs(output.stdout, "stdout", secrets),
          ...parseDockerLogs(output.stderr, "stderr", secrets),
        ]
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(-150);
        if (entries.length) {
          await this.backend.submitLogs(container.run_id, entries);
          this.cursors.set(container.container, entries.at(-1)!.timestamp);
        }
      } catch {
        console.error("[agent-logs] Could not collect container logs");
      }
    }
    for (const name of this.cursors.keys())
      if (!state.containers[name]) this.cursors.delete(name);
  }
}
