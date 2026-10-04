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
  private readonly boundForwards = new Map<number, SshForward>();
  private retryCount = 0;
  private nextRetryAt?: number;
  private lastError?: string;
  private lastErrorCode?: string;
  private lastErrorAt?: string;
  private connectionState:
    "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" =
    "idle";
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
        this.failed(error);
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

  report() {
    return {
      state: this.connectionState,
      retry_count: this.retryCount,
      ...(this.nextRetryAt
        ? { next_retry_at: new Date(this.nextRetryAt).toISOString() }
        : {}),
      ...(this.lastError
        ? {
            last_error: this.lastError,
            last_error_code: this.lastErrorCode,
            last_error_at: this.lastErrorAt,
          }
        : {}),
      platform: process.platform,
      arch: process.arch,
      version: "0.1.0",
    };
  }
  private failed(error: unknown) {
    this.retryCount = Math.min(this.retryCount + 1, 1000000);
    this.lastErrorAt = new Date().toISOString();
    this.lastError =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "SSH reconciliation failed";
    this.lastErrorCode =
      error instanceof Error && "code" in error
        ? String(error.code).slice(0, 64)
        : /authentication/i.test(this.lastError)
          ? "SSH_AUTH_FAILED"
          : /host.*key/i.test(this.lastError)
            ? "SSH_HOST_KEY_REJECTED"
            : "SSH_CONNECTION_ERROR";
    this.connectionState =
      this.client && this.connectedAt ? "connected" : "reconnecting";
    this.nextRetryAt =
      Date.now() +
      Math.min(30000, 1000 * 2 ** Math.min(this.retryCount, 5)) +
      Math.floor(Math.random() * 500);
  }
  private async reconcile(): Promise<void> {
    const requested = await this.backend.forwards().catch((error: unknown) => {
      const failure = new Error(
        error instanceof Error
          ? error.message
          : "Agent control API unavailable",
      );
      Object.assign(failure, { code: "CONTROL_API_UNAVAILABLE" });
      throw failure;
    });
    const state = await this.state.read();
    const allowedPorts = new Set(
      Object.values(state.containers).map((container) => container.host_port),
    );
    const forwards = selectSshForwards(requested, allowedPorts);
    if (this.nextRetryAt && Date.now() < this.nextRetryAt) return;
    if (!this.client || !this.connectedAt) {
      if (forwards.length === 0) {
        this.connectionState = "idle";
        this.nextRetryAt = undefined;
        return;
      }
      this.connectionState = this.retryCount ? "reconnecting" : "connecting";
      await this.connect(forwards);
      return;
    }
    // Add new ports before removing obsolete listeners. Existing channels drain.
    for (const forward of forwards) {
      if (!this.boundForwards.has(forward.gateway_port))
        await this.bindForward(this.client, forward.gateway_port);
      this.boundForwards.set(forward.gateway_port, forward);
    }
    for (const port of this.boundForwards.keys()) {
      if (forwards.some((f) => f.gateway_port === port)) continue;
      await this.cancelForward(this.client, port);
      this.boundForwards.delete(port);
    }
    this.retryCount = 0;
    this.nextRetryAt = undefined;
  }

  private async connect(forwards: SshForward[]): Promise<void> {
    const privateKey = await readFile(this.config.sshIdentityFile);
    const client = new Client();
    this.client = client;
    let sessionError: Error | undefined;

    client.on("tcp connection", (details, accept, reject) => {
      const forward = this.boundForwards.get(details.destPort);
      if (!forward) {
        reject();
        return;
      }
      const channel = accept();
      const local = connectLocal(forward.local_port, localTargetHost);
      local.once("close", () => channel.destroy());
      channel.once("close", () => local.destroy());
      channel.once("error", () => local.destroy());
      local.once("error", (error) => {
        this.lastErrorAt = new Date().toISOString();
        this.lastError = error.message.slice(0, 500);
        this.lastErrorCode = "APP_CONNECTION_ERROR";
        channel.destroy();
      });
      channel.pipe(local).pipe(channel);
    });
    client.on("error", (error) => {
      sessionError = error;
      console.error(`[ssh-tunnel] ${error.message}`);
    });
    client.on("close", () => {
      if (this.client !== client) return;
      const wasReady = this.connectedAt !== undefined;
      this.client = undefined;
      this.boundForwards.clear();
      this.connectedAt = undefined;
      if (!this.stopping && wasReady) {
        this.failed(sessionError ?? new Error("SSH connection closed"));
        console.error("[ssh-tunnel] SSH connection closed");
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        client.once("error", reject);
        client.once("close", () =>
          reject(new Error("SSH closed before ready")),
        );
        client.once("ready", () => {
          Promise.all(
            forwards.map((forward) =>
              this.bindForward(client, forward.gateway_port).then(() =>
                this.boundForwards.set(forward.gateway_port, forward),
              ),
            ),
          ).then(() => resolve(), reject);
        });
        client.connect(sshConnectionConfig(this.config, privateKey));
      });
      if (this.client !== client) {
        throw new Error("SSH connection closed before forwards were ready");
      }
      this.connectionState = "connected";
      this.retryCount = 0;
      this.nextRetryAt = undefined;
      this.connectedAt = Date.now();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  private bindForward(client: SshClient, gatewayPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        client.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const closed = () =>
        finish(new Error("SSH closed while opening forward"));
      const timer = setTimeout(() => {
        finish(new Error("SSH forward request timed out"));
        client.destroy();
      }, this.config.sshReadyTimeoutMs);
      timer.unref();
      client.once("close", closed);
      client.forwardIn(remoteBindHost, gatewayPort, (error, assignedPort) =>
        finish(
          error ??
            (assignedPort !== gatewayPort
              ? new Error("SSH server assigned an unexpected forward port")
              : undefined),
        ),
      );
    });
  }

  private cancelForward(client: SshClient, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        client.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const closed = () => finish(new Error("SSH closed while removing forward"));
      const timer = setTimeout(() => {
        finish(new Error("SSH forward removal timed out"));
        client.destroy();
      }, this.config.sshReadyTimeoutMs);
      timer.unref();
      client.once("close", closed);
      client.unforwardIn(remoteBindHost, port, (error) => finish(error ?? undefined));
    });
  }

  private disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.boundForwards.clear();
    this.connectedAt = undefined;
    this.connectionState = "disconnected";
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
