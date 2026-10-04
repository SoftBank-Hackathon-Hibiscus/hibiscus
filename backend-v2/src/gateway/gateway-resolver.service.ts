import { DatabaseService } from '../database/database.service.js';
import { Injectable } from '@nestjs/common';
import { ApplicationRepository } from '../application/application.repository.js';
import { RoutingService } from '../routing/routing.service.js';
import type { GatewayResolution } from './types/gateway.type.js';

@Injectable()
export class GatewayResolverService {
  private readonly cache = new Map<
    string,
    Omit<GatewayResolution, 'upstreamPath'>
  >();
  private revision: string | undefined;
  private readonly maxEntries = 1024;

  constructor(
    private readonly applications: ApplicationRepository,
    private readonly routing: RoutingService,
    private readonly database: DatabaseService,
  ) {}

  resolve(hostHeader: string | undefined, originalUrl: string) {
    const url = new URL(originalUrl, 'http://gateway.invalid');
    const host = this.host(hostHeader);
    if (!host) return undefined;
    const revision = this.database.cacheRevision();
    if (revision !== this.revision) {
      this.cache.clear();
      this.revision = revision;
    }
    let entry = this.cache.get(host);
    if (!entry) {
      const application = this.applications.findByPublicHost(host);
      if (!application) return undefined;
      const route = this.routing.resolveKnownApplication(application.id);
      entry = { application, target: route.target };
      if (this.cache.size >= this.maxEntries) this.cache.clear();
      this.cache.set(host, entry);
    }
    return {
      ...entry,
      upstreamPath: `${url.pathname}${url.search}`,
    } satisfies GatewayResolution;
  }

  private host(hostHeader: string | undefined) {
    if (!hostHeader) return undefined;
    let host: string;
    try {
      host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    return host;
  }
}
