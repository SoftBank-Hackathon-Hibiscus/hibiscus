import { ConflictException, Injectable } from '@nestjs/common';
import { DeploymentRepository } from '../deployment/deployment.repository.js';
import { RoutingRepository } from '../routing/routing.repository.js';
import { RoutingService } from '../routing/routing.service.js';

@Injectable()
export class FailoverService {
  constructor(
    private readonly repository: RoutingRepository,
    private readonly routing: RoutingService,
    private readonly deployments: DeploymentRepository,
  ) {}

  handleUnhealthyTarget(targetId: string): boolean {
    const failed = this.repository.findTarget(targetId);
    if (!failed || failed.kind !== 'onprem') return false;
    const failedHealth = this.repository.findHealth(failed.id);
    const now = new Date().toISOString();
    if (failedHealth?.status !== 'unhealthy' || failedHealth.expiresAt <= now) {
      return false;
    }
    const route = this.repository.route(failed.applicationId);
    if (!route || route.target.id !== failed.id) return false;
    const policy = this.deployments.findPolicyResult(failed.deploymentId);
    if (!policy?.failoverAllowed) return false;

    const fallback = this.repository
      .listTargets(failed.applicationId)
      .find(
        ({ target, health }) =>
          target.enabled &&
          target.kind === 'cloud_run' &&
          target.deploymentId === failed.deploymentId &&
          health?.status === 'healthy' &&
          health.expiresAt > now,
      );
    if (!fallback) return false;

    try {
      this.routing.changeRoute(
        failed.applicationId,
        {
          target_id: fallback.target.id,
          expected_revision: route.revision,
          reason: `Automatic failover from ${failed.id}`,
        },
        'system:health-monitor',
      );
      return true;
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }
}
