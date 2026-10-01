import type {
  RoutingTarget,
  RoutingTargetHealth,
} from '../../database/schema.js';

export interface RoutingTargetView {
  target: RoutingTarget;
  health: RoutingTargetHealth | null;
}

export interface RouteSnapshot {
  applicationId: string;
  target: RoutingTarget;
  revision: number;
  health: RoutingTargetHealth | null;
}

export interface TargetHealthObservation {
  targetId: string;
  deploymentId: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  observedAt: string;
  expiresAt: string;
  reason?: string;
}
