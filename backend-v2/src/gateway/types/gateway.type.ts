import type { Application, RoutingTarget } from '../../database/schema.js';

export interface GatewayResolution {
  application: Application;
  target: RoutingTarget;
  upstreamPath: string;
}
