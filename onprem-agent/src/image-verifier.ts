import type { AgentConfig } from "./config.js";
import { CommandError, type CommandExecutor } from "./command-runner.js";
import type { AgentJob, SignatureVerifier } from "./types.js";

export class CosignImageVerifier implements SignatureVerifier {
  constructor(
    private readonly config: AgentConfig,
    private readonly commands: CommandExecutor,
  ) {}

  async verify(job: AgentJob): Promise<void> {
    if (!job.image || !job.plan_hash) {
      throw new Error("Candidate job is missing image or plan_hash");
    }
    try {
      await this.commands.run(this.config.cosignCommand, [
        "verify",
        "--key",
        this.config.cosignPublicKey,
        ...(this.config.cosignAllowInsecureRegistry
          ? ["--allow-http-registry", "--allow-insecure-registry"]
          : []),
        ...(this.config.cosignInsecureIgnoreTlog
          ? ["--insecure-ignore-tlog"]
          : []),
        "-a",
        `run_id=${job.run_id}`,
        "-a",
        `plan_hash=${job.plan_hash}`,
        job.image,
      ]);
    } catch (error) {
      const detail =
        error instanceof CommandError ? error.stderr.slice(0, 512) : "";
      throw new Error(
        `Image signature verification failed${detail ? `: ${detail}` : ""}`,
      );
    }
  }
}
