import type { AgentConfig } from "./config.js";
import { CommandError, type CommandExecutor } from "./command-runner.js";
import type { AgentJob, ContainerRuntime, ManagedContainer } from "./types.js";

export class DockerRuntime implements ContainerRuntime {
  constructor(
    private readonly config: AgentConfig,
    private readonly commands: CommandExecutor,
  ) {}

  async createCandidate(
    job: AgentJob,
    existing?: ManagedContainer,
  ): Promise<ManagedContainer> {
    if (!job.image) throw new Error("Candidate job is missing image");
    await this.commands.run(this.config.dockerCommand, ["pull", job.image]);
    const name = this.containerName(job);
    if (existing) {
      try {
        await this.ensureManaged(existing);
        await this.start(existing.container);
        return existing;
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }
    const recovered = await this.recover(job, name);
    if (recovered) return recovered;

    await this.commands.run(this.config.dockerCommand, [
      "run",
      "-d",
      "--name",
      name,
      "--restart",
      "no",
      "--label",
      "hibiscus.managed=true",
      "--label",
      `hibiscus.run_id=${job.run_id}`,
      "--label",
      `hibiscus.digest=${job.digest}`,
      "-p",
      `127.0.0.1::${job.runtime.container_port}`,
      job.image,
    ]);
    const hostPort = await this.hostPort(name, job.runtime.container_port);
    return {
      run_id: job.run_id,
      digest: job.digest,
      container: name,
      image: job.image,
      url: `http://127.0.0.1:${hostPort}`,
      host_port: hostPort,
      container_port: job.runtime.container_port,
      role: "candidate",
    };
  }

  async activate(
    target: ManagedContainer,
    previous?: ManagedContainer,
  ): Promise<void> {
    await this.ensureManaged(target);
    await this.start(target.container);
    await this.commands.run(this.config.dockerCommand, [
      "update",
      "--restart",
      "unless-stopped",
      target.container,
    ]);
    if (previous && previous.container !== target.container) {
      await this.commands.run(this.config.dockerCommand, [
        "update",
        "--restart",
        "no",
        previous.container,
      ]);
    }
  }

  async remove(container: ManagedContainer): Promise<void> {
    try {
      await this.commands.run(this.config.dockerCommand, [
        "stop",
        "--time",
        String(this.config.dockerStopTimeoutSeconds),
        container.container,
      ]);
    } catch (error) {
      if (!this.isMissing(error)) throw error;
      return;
    }
    try {
      await this.commands.run(this.config.dockerCommand, [
        "rm",
        container.container,
      ]);
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
  }

  async reconcile(
    containers: ManagedContainer[],
    servingContainer: string | null,
  ): Promise<ManagedContainer[]> {
    const available: ManagedContainer[] = [];
    for (const container of containers) {
      try {
        await this.ensureManaged(container);
        if (container.container === servingContainer) {
          await this.start(container.container);
        }
        available.push(container);
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }
    return available;
  }

  private async recover(
    job: AgentJob,
    name: string,
  ): Promise<ManagedContainer | undefined> {
    let labels: Record<string, string>;
    try {
      const output = await this.commands.run(this.config.dockerCommand, [
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        name,
      ]);
      labels = JSON.parse(output.stdout) as Record<string, string>;
    } catch (error) {
      if (this.isMissing(error)) return undefined;
      throw error;
    }
    if (
      labels["hibiscus.managed"] !== "true" ||
      labels["hibiscus.run_id"] !== job.run_id ||
      labels["hibiscus.digest"] !== job.digest
    ) {
      throw new Error(`Container name is already in use: ${name}`);
    }
    await this.start(name);
    const hostPort = await this.hostPort(name, job.runtime.container_port);
    return {
      run_id: job.run_id,
      digest: job.digest,
      container: name,
      image: job.image!,
      url: `http://127.0.0.1:${hostPort}`,
      host_port: hostPort,
      container_port: job.runtime.container_port,
      role: "candidate",
    };
  }

  private async ensureManaged(container: ManagedContainer): Promise<void> {
    const output = await this.commands.run(this.config.dockerCommand, [
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      container.container,
    ]);
    const labels = JSON.parse(output.stdout) as Record<string, string>;
    if (
      labels["hibiscus.managed"] !== "true" ||
      labels["hibiscus.digest"] !== container.digest
    ) {
      throw new Error(
        `Container is not managed by Hibiscus: ${container.container}`,
      );
    }
  }

  private async start(name: string): Promise<void> {
    const state = await this.commands.run(this.config.dockerCommand, [
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    if (state.stdout !== "true") {
      await this.commands.run(this.config.dockerCommand, ["start", name]);
    }
  }

  private async hostPort(name: string, containerPort: number): Promise<number> {
    const output = await this.commands.run(this.config.dockerCommand, [
      "port",
      name,
      `${containerPort}/tcp`,
    ]);
    const address = output.stdout.split("\n")[0]?.trim() ?? "";
    const port = Number(address.slice(address.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Docker did not publish container port ${containerPort}`);
    }
    return port;
  }

  private containerName(job: AgentJob): string {
    const run = job.run_id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 32);
    const digest = job.digest.replace(/^sha256:/, "").slice(0, 12);
    return `hibiscus-${run}-${digest}`;
  }

  private isMissing(error: unknown): boolean {
    return (
      error instanceof CommandError &&
      /No such (object|container)/i.test(error.stderr)
    );
  }
}
