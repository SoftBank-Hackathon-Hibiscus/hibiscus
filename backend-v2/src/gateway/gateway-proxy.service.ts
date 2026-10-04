import { GatewayAdmission } from './types/gateway-admission.js';
import { TrafficService } from '../observability/traffic.service.js';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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
  private readonly admission = new GatewayAdmission();
  private readonly logger = new Logger(GatewayProxyService.name);
  private readonly metrics = {
    admitted: 0,
    rejected: 0,
    canceled: 0,
    queueWaitMs: 0,
    socketWaitMs: 0,
    upstreamHeaderMs: 0,
    headers: 0,
  };
  private readonly pending = new Set<AbortController>();
  private metricsTimer?: NodeJS.Timeout;
  private readonly onPremAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: 64,
    maxTotalSockets: 256,
    maxFreeSockets: 64,
  });
  private readonly cloudAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 64,
    maxTotalSockets: 256,
    maxFreeSockets: 64,
  });

  onModuleDestroy(): void {
    for (const controller of this.pending) controller.abort();
    if (this.metricsTimer) clearInterval(this.metricsTimer);
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
    if (!this.metricsTimer) {
      this.metricsTimer = setInterval(
        () =>
          this.logger.log({
            event: 'gateway_pool',
            ...this.metrics,
            apps: this.admission.snapshot(),
          }),
        30000,
      );
      this.metricsTimer.unref();
    }
    const controller = new AbortController();
    this.pending.add(controller);
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    if (request.aborted || response.destroyed) controller.abort();
    const release = await this.admission.acquire(
      resolution.application.id,
      this.config.get('backend.gatewayMaxActive', { infer: true }) ?? 64,
      this.config.get('backend.gatewayMaxQueued', { infer: true }) ?? 64,
      this.config.get('backend.gatewayQueueTimeoutMs', { infer: true }) ?? 1000,
      controller.signal,
    );
    this.pending.delete(controller);
    request.off('aborted', abort);
    response.off('close', abort);
    this.metrics.queueWaitMs += performance.now() - startedAt;
    if (!release) {
      if (controller.signal.aborted) {
        this.metrics.canceled++;
        return;
      }
      this.metrics.rejected++;
      response.setHeader('Retry-After', '1');
      response
        .status(503)
        .json({ statusCode: 503, message: 'Gateway is busy; retry later' });
      return;
    }
    this.metrics.admitted++;
    try {
      const headers = this.requestHeaders(request);
      const target = resolution.target;
      const timeout = this.config.get('backend.gatewayIdleTimeoutMs', {
        infer: true,
      });

      const outgoing =
        target.kind === 'onprem'
          ? await this.onPremRequest(resolution, request, headers)
          : this.cloudRunRequest(resolution, request, headers);

      outgoing.once('close', release);
      let poolTimeout = false;
      const socketTimer = setTimeout(
        () => {
          poolTimeout = true;
          outgoing.destroy(new Error('Gateway connection pool timeout'));
        },
        this.config.get('backend.gatewayQueueTimeoutMs', { infer: true }) ??
          1000,
      );
      socketTimer.unref();
      outgoing.once('socket', () => clearTimeout(socketTimer));
      outgoing.once('close', () => clearTimeout(socketTimer));
      const createdAt = performance.now();
      outgoing.once('socket', () => {
        this.metrics.socketWaitMs += performance.now() - createdAt;
      });
      outgoing.once('response', () => {
        this.metrics.headers++;
        this.metrics.upstreamHeaderMs += performance.now() - createdAt;
      });
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
        const status = poolTimeout
          ? 503
          : /timeout/i.test(error.message)
            ? 504
            : 502;
        if (poolTimeout) {
          this.metrics.rejected++;
          response.setHeader('Retry-After', '1');
        }
        response.status(status).json({
          statusCode: status,
          message:
            status === 503
              ? 'Gateway connection pool is busy; retry later'
              : status === 504
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
    } catch (error) {
      release();
      throw error;
    }
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
