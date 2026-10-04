import { TrafficService } from '../observability/traffic.service.js';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
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
export class GatewayProxyService implements OnModuleDestroy {
  private readonly onPremAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 64,
    maxTotalSockets: 256,
    maxFreeSockets: 16,
  });
  private readonly cloudAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 64,
    maxTotalSockets: 256,
    maxFreeSockets: 16,
  });

  onModuleDestroy(): void {
    this.onPremAgent.destroy();
    this.cloudAgent.destroy();
  }

  constructor(
    _tunnel: SshTunnelService,
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
      if (response.destroyed) {
        incoming.destroy();
        outgoing.destroy();
        return;
      }
      response.writeHead(
        incoming.statusCode ?? 502,
        incoming.statusMessage,
        this.responseHeaders(incoming.headers),
      );
      incoming.pipe(response);
    });
    outgoing.once('error', (error) => {
      if (response.destroyed || response.writableEnded) return;
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
    const cancel = () => {
      if (!response.writableFinished) outgoing.destroy();
    };
    request.once('aborted', cancel);
    // A complete GET body does not emit request.aborted when its client leaves.
    response.once('close', cancel);
    outgoing.once('close', () => {
      request.off('aborted', cancel);
      response.off('close', cancel);
    });
    // The client may disconnect while the async upstream request is created.
    if (request.aborted || response.destroyed) {
      outgoing.destroy();
      return;
    }
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody) outgoing.end(rawBody);
    else request.pipe(outgoing);
  }

  private async onPremRequest(
    resolution: GatewayResolution,
    request: Request,
    headers: OutgoingHttpHeaders,
  ) {
    if (!resolution.target.gatewayPort)
      throw new Error('SSH forward target is invalid');
    return httpRequest({
      method: request.method,
      host: '127.0.0.1',
      port: resolution.target.gatewayPort,
      path: resolution.upstreamPath,
      headers: { ...headers, host: request.headers.host },
      agent: this.onPremAgent,
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
      agent: this.cloudAgent,
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
