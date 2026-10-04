import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import BetterSqlite3 from 'better-sqlite3';
import { DatabaseService } from '../../database/database.service.js';
import { GatewayResolverService } from '../gateway-resolver.service.js';
import { ApplicationRepository } from '../../application/application.repository.js';
import { RoutingService } from '../../routing/routing.service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-cache-'));
  const path = join(dir, 'test.db');
  const database = new DatabaseService(
    new ConfigService({ backend: { databaseFile: path } }),
  );
  const external = new BetterSqlite3(path);
  external.exec('CREATE TABLE state (target TEXT, enabled INTEGER)');
  external.prepare('INSERT INTO state VALUES (?, ?)').run('first', 1);
  cleanups.push(() => {
    external.close();
    database.onModuleDestroy();
    rmSync(dir, { recursive: true });
  });
  const applications = {
    findByPublicHost: vi.fn((host: string) =>
      host === 'demo.test' ? { id: 'app' } : undefined,
    ),
  };
  const routing = {
    resolveKnownApplication: vi.fn(() => {
      const row = database.db.$client.prepare('SELECT * FROM state').get() as {
        target: string;
        enabled: number;
      };
      if (!row.enabled) throw new Error('disabled');
      return { target: { id: row.target } };
    }),
  };
  const resolver = new GatewayResolverService(
    applications as unknown as ApplicationRepository,
    routing as unknown as RoutingService,
    database,
  );
  return { resolver, applications, routing, database, external };
}
describe('gateway routing cache', () => {
  it('reuses routing lookup across 1000 requests while preserving each path', () => {
    const { resolver, applications, routing } = fixture();
    for (let i = 0; i < 1000; i++) {
      expect(
        resolver.resolve('DEMO.test:443', `/path/${i}?q=${i}`)?.upstreamPath,
      ).toBe(`/path/${i}?q=${i}`);
    }
    expect(applications.findByPublicHost).toHaveBeenCalledTimes(1);
    expect(routing.resolveKnownApplication).toHaveBeenCalledTimes(1);
    expect(resolver.resolve('unknown.test', '/')).toBeUndefined();
    expect(resolver.resolve(undefined, '/')).toBeUndefined();
  });
  it('invalidates immediately after same-connection writes', () => {
    const { resolver, database } = fixture();
    expect(resolver.resolve('demo.test', '/')?.target.id).toBe('first');
    database.db.$client.prepare('UPDATE state SET target = ?').run('second');
    expect(resolver.resolve('demo.test', '/')?.target.id).toBe('second');
  });
  it('detects external writes and does not serve a cached disabled target', () => {
    const { resolver, external } = fixture();
    resolver.resolve('demo.test', '/');
    external.prepare('UPDATE state SET target = ?').run('external');
    expect(resolver.resolve('demo.test', '/')?.target.id).toBe('external');
    external.exec('UPDATE state SET enabled = 0');
    expect(() => resolver.resolve('demo.test', '/')).toThrow('disabled');
  });
});
