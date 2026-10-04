import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { GatewayProxyService } from '../gateway-proxy.service.js';
import type { GatewayResolution } from '../types/gateway.type.js';

const servers: Server[] = [];
const service = new GatewayProxyService({} as never, {} as never, {} as never);
afterEach(async () => {
  service.onModuleDestroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});
async function upstream(body: string) {
  const server = createServer((_request, response) => response.end(body));
  servers.push(server);
  let connections = 0;
  server.on('connection', () => connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}
async function request(port: number) {
  const outgoing = await service['onPremRequest'](
    { target: { gatewayPort: port }, upstreamPath: '/' } as GatewayResolution,
    { method: 'GET', headers: { host: 'demo.hibiscus.lth.so' } } as never,
    {},
  );
  return new Promise<string>((resolve, reject) => {
    outgoing.on('error', reject);
    outgoing.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    outgoing.end();
  });
}
it('reuses connections for sequential requests and isolates different tunnel ports', async () => {
  const a = await upstream('a');
  const b = await upstream('b');
  for (let i = 0; i < 20; i++) {
    expect(await request(a.port)).toBe('a');
    expect(await request(b.port)).toBe('b');
  }
  expect(a.connections()).toBe(1);
  expect(b.connections()).toBe(1);
});
it('caps concurrent connections to each tunnel', async () => {
  const a = await upstream('ok');
  const results = await Promise.all(Array.from({ length: 100 }, () => request(a.port)));
  expect(results.every((body) => body === 'ok')).toBe(true);
  expect(a.connections()).toBeLessThanOrEqual(64);
});
