import 'reflect-metadata';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayProxyService } from '../gateway-proxy.service.js';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import type { SshTunnelService } from '../../ssh-tunnel/ssh-tunnel.service.js';
import { TrafficService } from '../../observability/traffic.service.js';

const servers: Server[] = [];
let service: GatewayProxyService;
afterEach(async () => {
  service?.onModuleDestroy();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function setup() {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  let requestAborted = false;
  const upstreamPort = await listen(
    createServer((req, res) => {
      if (req.url === '/hang' || req.url === '/stream') {
        if (req.url === '/stream') res.write('partial');
        res.once('close', markClosed);
        markStarted();
      } else res.end('ok');
    }),
  );
  service = new GatewayProxyService(
    {} as SshTunnelService,
    new TrafficService(),
    new ConfigService<BackendConfig, true>({
      backend: { gatewayIdleTimeoutMs: 10000 },
    }),
  );
  // One slot makes an abandoned upstream deterministically block the next request.
  service['onPremAgent'].maxSockets = 1;
  const gatewayPort = await listen(
    createServer((req, res) => {
      Object.assign(req, { protocol: 'http' });
      req.once('aborted', () => {
        requestAborted = true;
      });
      void service.proxy(
        req as Request,
        res as Response,
        {
          application: { id: 'app' },
          target: { id: 'target', kind: 'onprem', gatewayPort: upstreamPort },
          upstreamPath: req.url!,
        } as Parameters<GatewayProxyService['proxy']>[2],
      );
    }),
  );
  const hang = (path = '/hang') => {
    const client = request({
      host: '127.0.0.1',
      port: gatewayPort,
      path,
    });
    client.on('error', () => {});
    client.end();
    return client;
  };
  const healthy = () =>
    new Promise<string>((resolve, reject) => {
      const client = request(
        { host: '127.0.0.1', port: gatewayPort, path: '/ok' },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        },
      );
      client.on('error', reject);
      client.setTimeout(1500, () =>
        client.destroy(new Error('healthy request blocked')),
      );
      client.end();
    });
  return {
    started,
    closed,
    hang,
    healthy,
    requestAborted: () => requestAborted,
  };
}
it('cancels upstream after a completed GET client disconnects and releases its pool slot', async () => {
  const f = await setup();
  const client = f.hang();
  await f.started;
  client.destroy();
  await Promise.race([
    f.closed,
    delay(1000).then(() => {
      throw new Error('upstream not canceled');
    }),
  ]);
  expect(f.requestAborted()).toBe(false);
  expect(await f.healthy()).toBe('ok');
});
it('cancels a queued client and allows new traffic after the active client leaves', async () => {
  const f = await setup();
  const active = f.hang();
  await f.started;
  const queued = f.hang();
  await delay(50);
  expect(Object.values(service['onPremAgent'].requests).flat()).toHaveLength(1);
  queued.destroy();
  await delay(50);
  const pending = Object.values(service['onPremAgent'].requests).flat();
  // Node may retain a destroyed queued request until a socket becomes available.
  expect(pending.every((req) => req.destroyed)).toBe(true);
  active.destroy();
  await f.closed;
  expect(await f.healthy()).toBe('ok');
});
it('keeps normal responses working across repeated completed requests', async () => {
  const f = await setup();
  for (let i = 0; i < 20; i++) expect(await f.healthy()).toBe('ok');
});

it('cancels upstream when the client leaves during a partial response', async () => {
  const f = await setup();
  const client = f.hang('/stream');
  const received = new Promise<void>((resolve) => {
    client.once('response', (response) =>
      response.once('data', () => resolve()),
    );
  });
  await f.started;
  await received;
  client.destroy();
  await Promise.race([
    f.closed,
    delay(1000).then(() => {
      throw new Error('stream not canceled');
    }),
  ]);
  expect(await f.healthy()).toBe('ok');
});
