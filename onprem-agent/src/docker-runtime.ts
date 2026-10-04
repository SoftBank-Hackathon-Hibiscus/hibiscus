import { createServer } from "node:net";
import type { AgentConfig } from "./config.js";
import { CommandError, type CommandExecutor } from "./command-runner.js";
import type { AgentJob, ContainerRuntime, ManagedContainer } from "./types.js";

export class DockerRuntime implements ContainerRuntime {
  constructor(
    private readonly config: AgentConfig,
    private readonly commands: CommandExecutor,
    private readonly allocatePort = allocateHostPort,
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
        await this.verifyPort(existing);
        return existing;
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
    }
    const recovered = await this.recover(job, name);
    if (recovered) {
      await this.verifyPort(recovered);
      return recovered;
    }

    const expectedPort = existing?.host_port ?? await this.allocatePort();
    const environment = this.environmentArgs(job.runtime.environment);
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
      `127.0.0.1:${expectedPort}:${job.runtime.container_port}`,
      ...environment,
      job.image,
    ]);
    const hostPort = await this.hostPort(name, job.runtime.container_port);
    if (hostPort !== expectedPort) throw new Error("Candidate host port does not match its fixed binding");
    return {
      run_id: job.run_id,
      digest: job.digest,
      container: name,
      image: job.image,
      url: `http://127.0.0.1:${hostPort}`,
      host_port: hostPort,
      container_port: job.runtime.container_port,
      role: "candidate",
      environment: job.runtime.environment,
    };
  }

  async activate(
    target: ManagedContainer,
    previous?: ManagedContainer,
  ): Promise<void> {
    await this.ensureManaged(target);
    await this.start(target.container);
    await this.verifyPort(target);
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
          await this.verifyPort(container);
        }
        available.push(container);
      } catch (error) {
        if (!this.isMissing(error)) throw error;
        if (container.container === servingContainer) {
          available.push(await this.recreateServing(container));
        }
      }
    }
    return available;
  }

  private async recreateServing(
    container: ManagedContainer,
  ): Promise<ManagedContainer> {
    if (!container.image.endsWith(`@${container.digest}`)) {
      throw new Error(
        `Serving container image does not match its digest: ${container.container}`,
      );
    }
    await this.commands.run(this.config.dockerCommand, [
      "pull",
      container.image,
    ]);
    await this.commands.run(this.config.dockerCommand, [
      "run",
      "-d",
      "--name",
      container.container,
      "--restart",
      "unless-stopped",
      "--label",
      "hibiscus.managed=true",
      "--label",
      `hibiscus.run_id=${container.run_id}`,
      "--label",
      `hibiscus.digest=${container.digest}`,
      "-p",
      `127.0.0.1:${container.host_port}:${container.container_port}`,
      ...this.environmentArgs(container.environment),
      container.image,
    ]);
    const hostPort = await this.hostPort(
      container.container,
      container.container_port,
    );
    if (hostPort !== container.host_port) {
      throw new Error(
        `Recovered container port changed from ${container.host_port} to ${hostPort}`,
      );
    }
    return {
      ...container,
      url: `http://127.0.0.1:${hostPort}`,
      role: "serving",
    };
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
      environment: job.runtime.environment,
    };
  }

  private environmentArgs(environment?: Record<string, string>): string[] {
    return Object.entries(environment ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]);
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

  private async verifyPort(container: ManagedContainer): Promise<void> {
    const actual = await this.hostPort(container.container, container.container_port);
    if (actual !== container.host_port) {
      throw new Error(`Container host port changed: expected ${container.host_port}, actual ${actual}`);
    }
    const binding = await this.commands.run(this.config.dockerCommand, [
      "inspect", "--format", "{{json .HostConfig.PortBindings}}", container.container,
    ]);
    const ports = JSON.parse(binding.stdout) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
    const entries = ports[`${container.container_port}/tcp`] ?? [];
    if (entries.length !== 1 || entries[0]?.HostIp !== "127.0.0.1" || entries[0]?.HostPort !== String(container.host_port)) {
      throw new Error(`Container needs a fixed loopback binding on port ${container.host_port}: ${container.container}`);
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

async function allocateHostPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate host port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  // Docker must claim this exact port; a race or conflict fails instead of remapping it.
  return port;
}
