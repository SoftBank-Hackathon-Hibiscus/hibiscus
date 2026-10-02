import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationRepository } from '../application/application.repository.js';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { RoutingTarget } from '../database/schema.js';
import { RoutingRepository } from '../routing/routing.repository.js';
import { RoutingService } from '../routing/routing.service.js';
import { FailoverService } from './failover.service.js';
import { TargetHealthProbeService } from './target-health-probe.service.js';

@Injectable()
export class HealthMonitorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(HealthMonitorService.name);
  private readonly probing = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly applications: ApplicationRepository,
    private readonly repository: RoutingRepository,
    private readonly routing: RoutingService,
    private readonly probe: TargetHealthProbeService,
    private readonly failover: FailoverService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('backend.healthMonitorEnabled', { infer: true })) {
      return;
    }
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.config.get('backend.healthMonitorTickMs', { infer: true }),
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    await Promise.all(
      this.repository
        .listEnabledTargets()
        .filter((target) => this.isDue(target))
        .map((target) => this.check(target)),
    );
  }

  private isDue(target: RoutingTarget): boolean {
    if (this.probing.has(target.id)) return false;
    const view = this.applications.getView(target.applicationId);
    if (!view?.healthCheck.enabled) return false;
    const current = this.repository.findHealth(target.id);
    if (!current) return true;
    return (
      Date.now() - Date.parse(current.observedAt) >=
      view.healthCheck.intervalSeconds * 1_000
    );
  }

  private async check(target: RoutingTarget): Promise<void> {
    const view = this.applications.getView(target.applicationId);
    if (!view) return;
    this.probing.add(target.id);
    try {
      const result = await this.probe.check(target, view.healthCheck);
      const observedAt = new Date();
      const health = this.routing.recordHealth({
        targetId: target.id,
        deploymentId: target.deploymentId,
        status: result.status,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(
          observedAt.getTime() + view.healthCheck.intervalSeconds * 2_000,
        ).toISOString(),
        reason: result.reason,
        failureKind: result.failureKind,
      });
      if (health.status === 'unhealthy') {
        this.failover.handleUnhealthyTarget(target.id);
      }
    } catch (error) {
      this.logger.warn(
        `Health monitor failed for target ${target.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      this.probing.delete(target.id);
    }
  }
}
