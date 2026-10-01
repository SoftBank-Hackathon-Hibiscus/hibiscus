import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';

export interface TunnelSession {
  agentId: string;
  id: string;
  socket: WebSocket;
  connectedAt: string;
  lastPongAt: number;
  channels: Map<string, WebSocket | null>;
}

export interface PendingTunnelChannel {
  id: string;
  targetId: string;
  agentId: string;
  sessionId: string;
  resolve: (stream: Duplex) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class TunnelUnavailableError extends Error {}

export class TunnelCapacityError extends Error {}

export class TunnelOpenTimeoutError extends Error {}
