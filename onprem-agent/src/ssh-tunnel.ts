import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect as connectLocal } from "node:net";
import ssh2 from "ssh2";
import type { Client as SshClient, ConnectConfig } from "ssh2";
import type { AgentConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { BackendAgentClient, SshForward } from "./types.js";
import { sshKeyFingerprint } from "./ssh-identity.js";

const remoteBindHost = "127.0.0.1";
const localTargetHost = "127.0.0.1";
const { Client } = ssh2;

export class SshTunnel {
  private client?: SshClient;
  private signature?: string;
  private connectedAt?: number;
  private stopping = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly backend: BackendAgentClient,
    private readonly state: StateStore,
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
    void this.disconnect();
  }

  private async reconcile(): Promise<void> {
    const requested = await this.backend.forwards();
    const state = await this.state.read();
    const allowedPorts = new Set(
      Object.values(state.containers).map((container) => container.host_port),
    );
    const forwards = selectSshForwards(requested, allowedPorts);
    const signature = JSON.stringify(forwards);
    if (
      this.client &&
      signature === this.signature &&
      this.connectedAt !== undefined &&
      Date.now() - this.connectedAt < this.config.sshSessionMaxMs
    )
      return;

    await this.disconnect();
    if (forwards.length === 0) {
      this.signature = signature;
      this.connectedAt = Date.now();
      return;
    }
    await this.connect(forwards, signature);
  }

  private async connect(
    forwards: SshForward[],
    signature: string,
  ): Promise<void> {
    const privateKey = await readFile(this.config.sshIdentityFile);
    const client = new Client();
    const forwardsByGatewayPort = new Map(
      forwards.map((forward) => [forward.gateway_port, forward]),
    );
    this.client = client;

    client.on("tcp connection", (details, accept, reject) => {
      const forward = forwardsByGatewayPort.get(details.destPort);
      if (!forward) {
        reject();
        return;
      }
      const channel = accept();
      const local = connectLocal(forward.local_port, localTargetHost);
      channel.once("error", () => local.destroy());
      local.once("error", () => channel.destroy());
      channel.pipe(local).pipe(channel);
    });
    client.on("error", (error) => {
      console.error(`[ssh-tunnel] ${error.message}`);
    });
    client.on("close", () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.signature = undefined;
      this.connectedAt = undefined;
      if (!this.stopping) console.error("[ssh-tunnel] SSH connection closed");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("error", reject);
        client.once("ready", () => {
          Promise.all(
            forwards.map((forward) =>
              this.bindForward(client, forward.gateway_port),
            ),
          ).then(() => resolve(), reject);
        });
        client.connect(sshConnectionConfig(this.config, privateKey));
      });
      if (this.client !== client) {
        throw new Error("SSH connection closed before forwards were ready");
      }
      this.signature = signature;
      this.connectedAt = Date.now();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  private bindForward(client: SshClient, gatewayPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      client.forwardIn(remoteBindHost, gatewayPort, (error, assignedPort) => {
        if (error) {
          reject(error);
          return;
        }
        if (assignedPort !== gatewayPort) {
          reject(new Error("SSH server assigned an unexpected forward port"));
          return;
        }
        resolve();
      });
    });
  }

  private disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.signature = undefined;
    this.connectedAt = undefined;
    if (!client) return Promise.resolve();

    return new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        client.destroy();
        finish();
      }, 1_000);
      timer.unref();
      client.once("close", finish);
      client.end();
    });
  }

  private wait(delay: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export function sshConnectionConfig(
  config: AgentConfig,
  privateKey: Buffer,
): ConnectConfig {
  return {
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUser,
    privateKey,
    readyTimeout: config.sshReadyTimeoutMs,
    keepaliveInterval: config.sshServerAliveIntervalSeconds * 1_000,
    keepaliveCountMax: config.sshServerAliveCountMax,
    hostVerifier: (key: Buffer) => matchesHostKey(key, config.sshHostKeySha256),
  };
}

export function matchesHostKey(key: Buffer, expected: string): boolean {
  const actual = sshKeyFingerprint(key);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function selectSshForwards(
  requested: SshForward[],
  allowedLocalPorts: ReadonlySet<number>,
): SshForward[] {
  return requested
    .filter((forward) => allowedLocalPorts.has(forward.local_port))
    .sort((left, right) => left.gateway_port - right.gateway_port);
}
