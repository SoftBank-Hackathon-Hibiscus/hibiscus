import { TrafficService } from '../observability/traffic.service.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { Request, Response } from 'express';
import type { BackendConfig } from '../config/configs/backend.config.js';
import { SshTunnelService } from '../ssh-tunnel/ssh-tunnel.service.js';
import type { GatewayResolution } from './types/gateway.type.js';

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

@Injectable()
export class GatewayProxyService {
  constructor(
    private readonly tunnel: SshTunnelService,
    private readonly traffic: TrafficService,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  async proxy(
    request: Request,
    response: Response,
    resolution: GatewayResolution,
  ): Promise<void> {
    const startedAt = performance.now();
    response.once('finish', () =>
      this.traffic.record(
        resolution.application.id,
        resolution.target.id,
        response.statusCode,
        performance.now() - startedAt,
      ),
    );
    const headers = this.requestHeaders(request);
    const target = resolution.target;
    const timeout = this.config.get('backend.gatewayIdleTimeoutMs', {
      infer: true,
    });

    const outgoing =
      target.kind === 'onprem'
        ? await this.onPremRequest(resolution, request, headers)
        : this.cloudRunRequest(resolution, request, headers);

    this.watchIdle(request, outgoing, timeout);
    outgoing.once('response', (incoming) => {
      response.writeHead(
        incoming.statusCode ?? 502,
        incoming.statusMessage,
        this.responseHeaders(incoming.headers),
      );
      incoming.pipe(response);
    });
    outgoing.once('error', (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = /timeout/i.test(error.message) ? 504 : 502;
      response.status(status).json({
        statusCode: status,
        message:
          status === 504
            ? 'Gateway upstream timed out'
            : 'Gateway upstream is unavailable',
      });
    });
    request.once('aborted', () => outgoing.destroy());
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody) outgoing.end(rawBody);
    else request.pipe(outgoing);
  }

  private async onPremRequest(
    resolution: GatewayResolution,
    request: Request,
    headers: OutgoingHttpHeaders,
  ) {
    const stream = await this.tunnel.open(resolution.target);
    const agent = new HttpAgent({ keepAlive: false });
    agent.createConnection = () => stream as Socket;
    return httpRequest({
      method: request.method,
      host: 'onprem.internal',
      path: resolution.upstreamPath,
      headers: { ...headers, host: request.headers.host },
      agent,
    });
  }

  private cloudRunRequest(
    resolution: GatewayResolution,
    request: Request,
    headers: OutgoingHttpHeaders,
  ) {
    const base = new URL(resolution.target.url!);
    const upstream = new URL(resolution.upstreamPath, base);
    return httpsRequest(upstream, {
      method: request.method,
      headers,
    });
  }

  private requestHeaders(request: Request): OutgoingHttpHeaders {
    const headers = this.filteredHeaders(request.headers);
    delete headers.host;
    headers['x-forwarded-for'] = request.socket.remoteAddress ?? '';
    headers['x-forwarded-host'] = request.headers.host ?? '';
    headers['x-forwarded-proto'] = request.protocol;
    return headers;
  }

  private watchIdle(
    request: Request,
    outgoing: ReturnType<typeof httpRequest>,
    timeout: number,
  ): void {
    let timer: NodeJS.Timeout | undefined;
    const clear = () => {
      if (timer) clearTimeout(timer);
    };
    const touch = () => {
      clear();
      timer = setTimeout(() => {
        outgoing.destroy(new Error('Gateway upstream idle timeout'));
      }, timeout);
      timer.unref();
    };
    touch();
    request.on('data', touch);
    outgoing.once('response', (incoming) => {
      touch();
      incoming.on('data', touch);
      incoming.once('end', clear);
      incoming.once('close', clear);
    });
    outgoing.once('close', clear);
  }

  private responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    return this.filteredHeaders(headers);
  }

  private filteredHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    return Object.fromEntries(
      Object.entries(headers).filter(
        ([name, value]) =>
          value !== undefined && !hopByHopHeaders.has(name.toLowerCase()),
      ),
    );
  }
}
