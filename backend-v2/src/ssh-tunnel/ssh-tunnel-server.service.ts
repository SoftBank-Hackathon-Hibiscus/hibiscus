import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import ssh2 from 'ssh2';
import type {
  AuthContext,
  Connection,
  ServerChannel,
  TcpipBindInfo,
} from 'ssh2';
import { SshConnectionStateService } from './ssh-connection-state.service.js';
import { AgentService } from '../agent/agent.service.js';
import type { BackendConfig } from '../config/configs/backend.config.js';
import { SshTunnelAuthService } from './ssh-tunnel-auth.service.js';
import { SshTunnelEndpointService } from './ssh-tunnel-endpoint.service.js';
import { SshTunnelHostKeyService } from './ssh-tunnel-host-key.service.js';

const { Server } = ssh2;

interface TunnelSession {
  agentId: string;
  connection: Connection;
  listeners: Map<number, TcpServer>;
  sockets: Set<Socket | ServerChannel>;
}

@Injectable()
export class SshTunnelServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SshTunnelServerService.name);
  private readonly connections = new Set<Connection>();
  private readonly sessions = new Map<string, TunnelSession>();
  private server?: InstanceType<typeof Server>;
  private unsubscribeTokenInvalidation?: () => void;

  constructor(
    private readonly state: SshConnectionStateService,
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly hostKey: SshTunnelHostKeyService,
    private readonly endpoint: SshTunnelEndpointService,
    private readonly auth: SshTunnelAuthService,
    private readonly agents: AgentService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribeTokenInvalidation = this.agents.onTokenInvalidated(
      (agentId) => this.closeAgent(agentId),
    );
    if (!this.config.get('backend.sshServerEnabled', { infer: true })) return;

    const server = new Server(
      {
        hostKeys: [this.hostKey.key()],
        ident: 'Hibiscus_Tunnel',
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      },
      (connection) => this.acceptConnection(connection),
    );
    server.on('error', (error: Error) => {
      this.logger.error(`SSH tunnel server error: ${error.message}`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(
        this.config.get('backend.sshPort', { infer: true }),
        this.config.get('backend.sshBindHost', { infer: true }),
        () => {
          server.off('error', reject);
          resolve();
        },
      );
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('SSH tunnel server did not bind a TCP port');
    }
    this.endpoint.setListeningPort(address.port);
    this.logger.log(
      `SSH tunnel server listening on ${this.config.get('backend.sshBindHost', { infer: true })}:${address.port}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribeTokenInvalidation?.();
    for (const session of this.sessions.values()) {
      this.closeSession(session);
    }
    for (const connection of this.connections) connection.end();
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private acceptConnection(connection: Connection): void {
    let agentId: string | undefined;
    let activeSession: TunnelSession | undefined;
    this.connections.add(connection);
    connection.on('error', (error) => {
      if (agentId)
        this.state.event(
          agentId,
          'session_error',
          'SSH_SESSION_ERROR',
          error.message,
        );
      this.logger.warn(
        `SSH connection${agentId ? ` for Agent ${agentId}` : ''} failed: ${error.message}`,
      );
    });
    connection.once('close', () => {
      this.connections.delete(connection);
      if (activeSession) this.closeSession(activeSession, false);
    });
    connection.on('authentication', (context: AuthContext) => {
      const authenticatedAgentId = this.auth.authenticate(context);
      if (!authenticatedAgentId) {
        context.reject(['publickey']);
        return;
      }
      agentId = authenticatedAgentId;
      context.accept();
    });
    connection.on('ready', () => {
      if (!agentId) {
        connection.end();
        return;
      }
      const previous = this.sessions.get(agentId);
      if (previous) this.closeSession(previous);
      const session: TunnelSession = {
        agentId,
        connection,
        listeners: new Map(),
        sockets: new Set(),
      };
      activeSession = session;
      this.sessions.set(agentId, session);
      this.state.connected(agentId);
      connection.on('session', (_accept, reject) => reject());
      connection.on('tcpip', (_accept, reject) => reject());
      connection.on('openssh.streamlocal', (_accept, reject) => reject());
      connection.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          void this.startForward(session, info, accept, reject);
          return;
        }
        if (name === 'cancel-tcpip-forward') {
          this.stopForward(session, info.bindPort);
          accept?.();
          return;
        }
        reject?.();
      });
    });
  }

  private async startForward(
    session: TunnelSession,
    info: TcpipBindInfo,
    accept: ((chosenPort?: number) => void) | undefined,
    reject: (() => void) | undefined,
  ): Promise<void> {
    if (
      !accept ||
      !reject ||
      session.listeners.has(info.bindPort) ||
      !this.auth.canForward(session.agentId, info.bindAddr, info.bindPort)
    ) {
      reject?.();
      return;
    }

    const listener = createTcpServer((socket) => {
      session.sockets.add(socket);
      socket.on('error', (error) =>
        this.state.event(
          session.agentId,
          'channel_error',
          'GATEWAY_SOCKET_ERROR',
          error.message,
          info.bindPort,
        ),
      );
      socket.once('close', () => session.sockets.delete(socket));
      session.connection.forwardOut(
        info.bindAddr,
        info.bindPort,
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        (error, channel) => {
          if (error) {
            this.state.event(
              session.agentId,
              'channel_error',
              'SSH_FORWARD_ERROR',
              error.message,
              info.bindPort,
            );
            socket.destroy();
            return;
          }
          session.sockets.add(channel);
          channel.on('error', (error: Error) => {
            this.state.event(
              session.agentId,
              'channel_error',
              'SSH_CHANNEL_ERROR',
              error.message,
              info.bindPort,
            );
            socket.destroy();
          });
          socket.once('close', () => channel.destroy());
          channel.once('close', () => session.sockets.delete(channel));
          socket.pipe(channel).pipe(socket);
        },
      );
    });
    listener.on('error', (error) => {
      this.state.event(
        session.agentId,
        'forward_error',
        'SSH_BIND_ERROR',
        error.message,
        info.bindPort,
      );
      this.logger.warn(
        `SSH forward ${info.bindPort} failed for Agent ${session.agentId}: ${error.message}`,
      );
    });
    try {
      await new Promise<void>((resolve, rejectListen) => {
        listener.once('error', rejectListen);
        listener.listen(info.bindPort, '127.0.0.1', () => {
          listener.off('error', rejectListen);
          resolve();
        });
      });
      if (this.sessions.get(session.agentId) !== session) {
        listener.close();
        reject();
        return;
      }
      session.listeners.set(info.bindPort, listener);
      this.state.forward(session.agentId, info.bindPort, true);
      accept();
    } catch {
      if (listener.listening) listener.close();
      reject();
    }
  }

  private stopForward(session: TunnelSession, port: number): void {
    const listener = session.listeners.get(port);
    session.listeners.delete(port);
    if (listener) this.state.forward(session.agentId, port, false);
    listener?.close();
  }

  private closeAgent(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (session) this.closeSession(session);
  }

  private closeSession(session: TunnelSession, end = true): void {
    if (this.sessions.get(session.agentId) === session) {
      this.sessions.delete(session.agentId);
      this.state.disconnected(
        session.agentId,
        end ? 'Server closed session' : 'Peer closed session',
      );
    }
    for (const listener of session.listeners.values()) listener.close();
    session.listeners.clear();
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
    if (end) session.connection.end();
  }
}
