import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket, {
  createWebSocketStream,
  type RawData,
  WebSocketServer,
} from 'ws';
import { AgentService } from '../agent/agent.service.js';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { RoutingTarget } from '../database/schema.js';
import { RoutingRepository } from '../routing/routing.repository.js';
import type {
  PendingTunnelChannel,
  TunnelSession,
} from './types/tunnel.type.js';
import {
  TunnelCapacityError,
  TunnelOpenTimeoutError,
  TunnelUnavailableError,
} from './types/tunnel.type.js';

@Injectable()
export class TunnelService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TunnelService.name);
  private readonly controlServer: WebSocketServer;
  private readonly dataServer: WebSocketServer;
  private readonly sessions = new Map<string, TunnelSession>();
  private readonly pending = new Map<string, PendingTunnelChannel>();
  private server?: Server;
  private heartbeatTimer?: NodeJS.Timeout;
  private removeTokenListener?: () => void;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly agents: AgentService,
    private readonly routing: RoutingRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {
    const maxPayload = this.config.get('backend.tunnelMaxFrameBytes', {
      infer: true,
    });
    this.controlServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
    });
    this.dataServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload,
    });
  }

  onApplicationBootstrap(): void {
    this.server = this.httpAdapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.handleUpgrade);
    this.heartbeatTimer = setInterval(
      () => this.checkHeartbeats(),
      this.config.get('backend.tunnelPingIntervalMs', { infer: true }),
    );
    this.heartbeatTimer.unref();
    this.removeTokenListener = this.agents.onTokenInvalidated((agentId) =>
      this.closeAgent(agentId, 4003, 'Agent token changed'),
    );
  }

  onModuleDestroy(): void {
    if (this.server) this.server.off('upgrade', this.handleUpgrade);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.removeTokenListener?.();
    for (const session of this.sessions.values()) {
      this.closeSession(session, 1001, 'Server shutting down');
    }
    this.controlServer.close();
    this.dataServer.close();
  }

  status(agentId: string) {
    const session = this.sessions.get(agentId);
    return session
      ? {
          connected: true,
          session_id: session.id,
          connected_at: session.connectedAt,
          active_channels: session.channels.size,
        }
      : {
          connected: false,
          session_id: null,
          connected_at: null,
          active_channels: 0,
        };
  }

  openTarget(targetId: string): Promise<Duplex> {
    const target = this.routing.findTarget(targetId);
    if (!target || !target.enabled) {
      return Promise.reject(
        new TunnelUnavailableError('Routing target is unavailable'),
      );
    }
    return this.open(target);
  }

  open(target: RoutingTarget): Promise<Duplex> {
    if (target.kind !== 'onprem' || !target.agentId || !target.localPort) {
      return Promise.reject(
        new TunnelUnavailableError('Routing target is not an on-prem target'),
      );
    }
    const session = this.sessions.get(target.agentId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new TunnelUnavailableError('Agent tunnel is offline'),
      );
    }
    const limit = this.config.get('backend.tunnelMaxChannelsPerAgent', {
      infer: true,
    });
    if (session.channels.size >= limit) {
      return Promise.reject(
        new TunnelCapacityError('Agent tunnel channel limit reached'),
      );
    }

    return new Promise<Duplex>((resolve, reject) => {
      const channelId = randomUUID();
      const timeoutMs = this.config.get('backend.tunnelOpenTimeoutMs', {
        infer: true,
      });
      const timer = setTimeout(() => {
        this.pending.delete(channelId);
        session.channels.delete(channelId);
        reject(new TunnelOpenTimeoutError('Agent tunnel open timed out'));
      }, timeoutMs);
      const pending: PendingTunnelChannel = {
        id: channelId,
        targetId: target.id,
        agentId: target.agentId!,
        sessionId: session.id,
        resolve,
        reject,
        timer,
      };
      this.pending.set(channelId, pending);
      session.channels.set(channelId, null);
      try {
        session.socket.send(
          JSON.stringify({
            type: 'open',
            protocol_version: 1,
            session_id: session.id,
            channel_id: channelId,
            target_id: target.id,
            local_host: '127.0.0.1',
            local_port: target.localPort,
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(channelId);
        session.channels.delete(channelId);
        reject(new TunnelUnavailableError('Unable to request tunnel channel'));
      }
    });
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/agent/v1/tunnel/control') {
      this.upgradeControl(request, socket as Socket, head);
      return;
    }
    if (url.pathname === '/agent/v1/tunnel/data') {
      this.upgradeData(request, socket as Socket, head, url);
    }
  };

  private upgradeControl(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    const agent = this.authenticateUpgrade(request, socket);
    if (!agent) return;
    this.controlServer.handleUpgrade(request, socket, head, (webSocket) => {
      const previous = this.sessions.get(agent.id);
      if (previous)
        this.closeSession(previous, 4001, 'Replaced by new session');
      const session: TunnelSession = {
        agentId: agent.id,
        id: randomUUID(),
        socket: webSocket,
        connectedAt: new Date().toISOString(),
        lastPongAt: Date.now(),
        channels: new Map(),
      };
      this.sessions.set(agent.id, session);
      webSocket.on('pong', () => {
        session.lastPongAt = Date.now();
      });
      webSocket.on('message', (raw) => this.handleControlMessage(session, raw));
      webSocket.on('close', () => {
        if (this.sessions.get(agent.id)?.id === session.id) {
          this.closeSession(session, 1000, 'Control connection closed');
        }
      });
      webSocket.on('error', (error) => {
        this.logger.warn(
          `Tunnel control error for agent ${agent.id}: ${error.message}`,
        );
      });
      webSocket.send(
        JSON.stringify({
          type: 'ready',
          protocol_version: 1,
          session_id: session.id,
        }),
      );
    });
  }

  private upgradeData(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    url: URL,
  ): void {
    const agent = this.authenticateUpgrade(request, socket);
    if (!agent) return;
    const sessionId = url.searchParams.get('session_id');
    const channelId = url.searchParams.get('channel_id');
    const session = this.sessions.get(agent.id);
    const channel = channelId ? this.pending.get(channelId) : undefined;
    if (
      !sessionId ||
      !channelId ||
      !session ||
      session.id !== sessionId ||
      !channel ||
      channel.agentId !== agent.id ||
      channel.sessionId !== sessionId
    ) {
      this.rejectUpgrade(socket, 409, 'Tunnel channel is invalid');
      return;
    }

    this.dataServer.handleUpgrade(request, socket, head, (webSocket) => {
      clearTimeout(channel.timer);
      this.pending.delete(channel.id);
      session.channels.set(channel.id, webSocket);
      const stream = createWebSocketStream(webSocket, { allowHalfOpen: false });
      const remove = () => session.channels.delete(channel.id);
      webSocket.once('close', remove);
      stream.once('error', remove);
      channel.resolve(stream);
    });
  }

  private authenticateUpgrade(request: IncomingMessage, socket: Socket) {
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match) {
      this.rejectUpgrade(socket, 401, 'Bearer agent token is required');
      return undefined;
    }
    try {
      return this.agents.authenticate(match[1]!);
    } catch {
      this.rejectUpgrade(socket, 401, 'Agent token is invalid or revoked');
      return undefined;
    }
  }

  private handleControlMessage(session: TunnelSession, raw: RawData): void {
    let message: { type?: string; channel_id?: string; code?: string };
    try {
      message = JSON.parse(this.webSocketText(raw)) as typeof message;
    } catch {
      session.socket.close(1003, 'Invalid control message');
      return;
    }
    if (message.type !== 'open_error' || !message.channel_id) return;
    const pending = this.pending.get(message.channel_id);
    if (!pending || pending.sessionId !== session.id) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.id);
    session.channels.delete(pending.id);
    pending.reject(
      new TunnelUnavailableError(
        `Agent could not open tunnel channel: ${message.code ?? 'UNKNOWN'}`,
      ),
    );
  }

  private webSocketText(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return Buffer.concat(data).toString('utf8');
  }

  private rejectUpgrade(socket: Socket, status: number, message: string): void {
    const body = `${message}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Conflict'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  private checkHeartbeats(): void {
    const timeout = this.config.get('backend.tunnelHeartbeatTimeoutMs', {
      infer: true,
    });
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastPongAt >= timeout) {
        this.closeSession(session, 4000, 'Heartbeat timed out');
      } else if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.ping();
      }
    }
  }

  private closeAgent(agentId: string, code: number, reason: string): void {
    const session = this.sessions.get(agentId);
    if (session) this.closeSession(session, code, reason);
  }

  private closeSession(
    session: TunnelSession,
    code: number,
    reason: string,
  ): void {
    if (this.sessions.get(session.agentId)?.id === session.id) {
      this.sessions.delete(session.agentId);
    }
    for (const channelId of session.channels.keys()) {
      const pending = this.pending.get(channelId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(channelId);
        pending.reject(new TunnelUnavailableError('Agent tunnel disconnected'));
      }
      session.channels.get(channelId)?.terminate();
    }
    session.channels.clear();
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.close(code, reason);
    } else if (session.socket.readyState !== WebSocket.CLOSED) {
      session.socket.terminate();
    }
  }
}
