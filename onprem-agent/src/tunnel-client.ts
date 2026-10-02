import { connect, type Socket } from "node:net";
import WebSocket, { createWebSocketStream, type RawData } from "ws";
import type { AgentConfig } from "./config.js";
import { FatalTunnelError } from "./types.js";
import type {
  ControlMessage,
  OpenMessage,
  TunnelTargetAuthorizer,
} from "./types.js";

export class TunnelClient {
  private control?: WebSocket;
  private sessionId?: string;
  private stopping = false;
  private readonly channels = new Map<
    string,
    { data: WebSocket; local: Socket }
  >();

  constructor(
    private readonly config: AgentConfig,
    private readonly targets: TunnelTargetAuthorizer,
  ) {}

  async start(): Promise<void> {
    let delay = this.config.reconnectMinMs;
    while (!this.stopping) {
      try {
        await this.connectOnce();
        delay = this.config.reconnectMinMs;
      } catch (error) {
        if (this.stopping) return;
        if (error instanceof FatalTunnelError) throw error;
        console.error(
          `[tunnel-agent] connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
      if (this.stopping) return;
      await this.wait(this.withJitter(delay));
      delay = Math.min(delay * 2, this.config.reconnectMaxMs);
    }
  }

  stop(): void {
    this.stopping = true;
    this.closeChannels();
    if (this.control?.readyState === WebSocket.OPEN) {
      this.control.close(1000, "Agent shutting down");
    } else if (this.control && this.control.readyState !== WebSocket.CLOSED) {
      this.control.terminate();
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const control = new WebSocket(this.config.controlUrl, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        handshakeTimeout: this.config.handshakeTimeoutMs,
        perMessageDeflate: false,
      });
      this.control = control;
      control.once("open", () => {
        opened = true;
        console.log("[tunnel-agent] control connection opened");
      });
      control.on("message", (raw) => this.handleMessage(raw));
      control.once("unexpected-response", (_request, response) => {
        response.resume();
        const error =
          response.statusCode === 401 || response.statusCode === 403
            ? new FatalTunnelError("Agent token was rejected")
            : new Error(`Tunnel upgrade failed with ${response.statusCode}`);
        settled = true;
        control.terminate();
        reject(error);
      });
      control.once("error", (error) => {
        if (!opened && !settled) {
          settled = true;
          reject(error);
        }
      });
      control.once("close", () => {
        this.sessionId = undefined;
        this.closeChannels();
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  private handleMessage(raw: RawData): void {
    let message: ControlMessage;
    try {
      message = JSON.parse(this.text(raw)) as ControlMessage;
    } catch {
      this.control?.close(1003, "Invalid control message");
      return;
    }
    if (message.type === "ready") {
      this.sessionId = message.session_id;
      console.log(`[tunnel-agent] session ready: ${message.session_id}`);
      return;
    }
    if (
      message.type === "open" &&
      message.protocol_version === 1 &&
      message.session_id === this.sessionId &&
      message.local_host === "127.0.0.1" &&
      Number.isInteger(message.local_port) &&
      message.local_port > 0 &&
      message.local_port <= 65_535
    ) {
      void this.openChannel(message);
    }
  }

  private async openChannel(message: OpenMessage): Promise<void> {
    if (this.channels.has(message.channel_id)) return;
    let port: number | undefined;
    try {
      port = await this.targets.authorize(message);
    } catch {
      this.sendOpenError(message.channel_id, "TARGET_AUTHORIZATION_FAILED");
      return;
    }
    if (port === undefined) {
      this.sendOpenError(message.channel_id, "TARGET_NOT_ALLOWED");
      return;
    }
    let local: Socket;
    try {
      local = await this.connectLocal(port);
    } catch {
      this.sendOpenError(message.channel_id, "LOCAL_CONNECT_FAILED");
      return;
    }

    const url = new URL(this.config.dataUrl);
    url.searchParams.set("session_id", message.session_id);
    url.searchParams.set("channel_id", message.channel_id);
    const data = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      handshakeTimeout: this.config.handshakeTimeoutMs,
      perMessageDeflate: false,
    });
    this.channels.set(message.channel_id, { data, local });
    const cleanup = () => {
      if (this.channels.get(message.channel_id)?.data !== data) return;
      this.channels.delete(message.channel_id);
      local.destroy();
      if (data.readyState === WebSocket.OPEN) data.close();
      else if (data.readyState !== WebSocket.CLOSED) data.terminate();
    };
    data.once("open", () => {
      const tunnel = createWebSocketStream(data, { allowHalfOpen: false });
      tunnel.once("error", cleanup);
      local.once("error", cleanup);
      local.once("close", cleanup);
      tunnel.pipe(local).pipe(tunnel);
    });
    data.once("unexpected-response", (_request, response) => {
      response.resume();
      cleanup();
    });
    data.once("error", cleanup);
    data.once("close", cleanup);
  }

  private connectLocal(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Local connection timed out"));
      }, this.config.localConnectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private sendOpenError(channelId: string, code: string): void {
    if (this.control?.readyState !== WebSocket.OPEN) return;
    this.control.send(
      JSON.stringify({ type: "open_error", channel_id: channelId, code }),
    );
  }

  private closeChannels(): void {
    for (const channel of this.channels.values()) {
      channel.local.destroy();
      channel.data.terminate();
    }
    this.channels.clear();
  }

  private text(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    return Buffer.concat(data).toString("utf8");
  }

  private withJitter(delay: number): number {
    return Math.round(delay * (0.8 + Math.random() * 0.4));
  }

  private wait(delay: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
