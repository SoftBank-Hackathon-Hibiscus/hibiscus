import { Injectable } from '@nestjs/common';
import { ApplicationRepository } from '../application/application.repository.js';
import { RoutingService } from '../routing/routing.service.js';
import type { GatewayResolution } from './types/gateway.type.js';

@Injectable()
export class GatewayResolverService {
  constructor(
    private readonly applications: ApplicationRepository,
    private readonly routing: RoutingService,
  ) {}

  resolve(hostHeader: string | undefined, originalUrl: string) {
    const url = new URL(originalUrl, 'http://gateway.invalid');
    const application = this.findByHost(hostHeader);
    if (!application) return undefined;

    const route = this.routing.resolve(application.id);
    return {
      application,
      target: route.target,
      upstreamPath: `${url.pathname}${url.search}`,
    } satisfies GatewayResolution;
  }

  private findByHost(hostHeader: string | undefined) {
    if (!hostHeader) return undefined;
    let host: string;
    try {
      host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    return this.applications.findByPublicHost(host);
  }
}
