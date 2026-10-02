import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AgentService } from '../agent/agent.service.js';
import { ApplicationRepository } from '../application/application.repository.js';
import { DeploymentRepository } from '../deployment/deployment.repository.js';
import type { RoutingTargetHealth } from '../database/schema.js';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type {
  CreateRoutingTargetDto,
  UpdateApplicationRouteDto,
} from './dto/routing.dto.js';
import { RoutingRepository } from './routing.repository.js';
import type {
  RouteSnapshot,
  RoutingTargetView,
  TargetHealthObservation,
} from './types/routing.type.js';

@Injectable()
export class RoutingService {
  constructor(
    private readonly repository: RoutingRepository,
    private readonly applications: ApplicationRepository,
    private readonly deployments: DeploymentRepository,
    private readonly agents: AgentService,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  createTarget(applicationId: string, input: CreateRoutingTargetDto) {
    this.requireApplication(applicationId);
    const deployment = this.deployments.find(input.deployment_id);
    if (!deployment || deployment.applicationId !== applicationId) {
      throw new NotFoundException('Deployment not found for application');
    }
    this.requireAllowedTarget(deployment.id, input.kind);

    let agentId: string | null = null;
    let localPort: number | null = null;
    let gatewayPort: number | null = null;
    let url: string | null = null;
    if (input.kind === 'onprem') {
      if (!input.agent_id || input.local_port === undefined) {
        throw new BadRequestException(
          'On-prem target requires agent_id and local_port',
        );
      }
      if (input.url !== undefined) {
        throw new BadRequestException('On-prem target must not include url');
      }
      this.agents.get(input.agent_id);
      if (!this.agents.isAssigned(applicationId, input.agent_id)) {
        throw new ConflictException('Agent is not assigned to application');
      }
      agentId = input.agent_id;
      localPort = input.local_port;
      gatewayPort =
        this.repository.allocateGatewayPort(
          this.config.get('backend.sshForwardPortMin', { infer: true }),
          this.config.get('backend.sshForwardPortMax', { infer: true }),
        ) ?? null;
      if (gatewayPort === null) {
        throw new ConflictException('No SSH forward port is available');
      }
    } else {
      if (!input.url) {
        throw new BadRequestException('Cloud Run target requires url');
      }
      if (input.agent_id !== undefined || input.local_port !== undefined) {
        throw new BadRequestException(
          'Cloud Run target must not include agent_id or local_port',
        );
      }
      url = this.cloudRunUrl(input.url);
    }

    if (
      this.repository.findEquivalentTarget(
        applicationId,
        deployment.id,
        input.kind,
        agentId,
      )
    ) {
      throw new ConflictException('Routing target already exists');
    }

    const now = new Date().toISOString();
    return this.repository.createTarget({
      id: randomUUID(),
      applicationId,
      deploymentId: deployment.id,
      kind: input.kind,
      agentId,
      localPort,
      gatewayPort,
      url,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    });
  }

  listTargets(applicationId: string): RoutingTargetView[] {
    this.requireApplication(applicationId);
    return this.repository
      .listTargets(applicationId)
      .map((view) => ({ ...view, health: this.effectiveHealth(view.health) }));
  }

  getRoute(applicationId: string): RouteSnapshot {
    this.requireApplication(applicationId);
    const route = this.repository.route(applicationId);
    if (!route) throw new NotFoundException('Application route not found');
    return { ...route, health: this.effectiveHealth(route.health) };
  }

  changeRoute(
    applicationId: string,
    input: UpdateApplicationRouteDto,
    changedBy: string,
  ): RouteSnapshot {
    this.requireApplication(applicationId);
    const target = this.repository.findTarget(input.target_id);
    if (!target || target.applicationId !== applicationId) {
      throw new NotFoundException('Routing target not found for application');
    }
    if (!target.enabled) {
      throw new ConflictException('Routing target is disabled');
    }
    this.requireAllowedTarget(target.deploymentId, target.kind);
    const route = this.repository.changeRoute(
      applicationId,
      target.id,
      input.expected_revision,
      changedBy,
      input.reason ?? null,
    );
    if (!route) {
      throw new ConflictException('Routing revision does not match');
    }
    return { ...route, health: this.effectiveHealth(route.health) };
  }

  resolve(applicationId: string): RouteSnapshot {
    const route = this.getRoute(applicationId);
    if (!route.target.enabled) {
      throw new ConflictException('Routing target is disabled');
    }
    return route;
  }

  recordHealth(input: TargetHealthObservation): RoutingTargetHealth {
    const target = this.repository.findTarget(input.targetId);
    if (!target) throw new NotFoundException('Routing target not found');
    if (target.deploymentId !== input.deploymentId) {
      throw new ConflictException(
        'Health deployment does not match routing target',
      );
    }
    const observedAt = new Date(input.observedAt).toISOString();
    const expiresAt = new Date(input.expiresAt).toISOString();
    if (expiresAt <= observedAt) {
      throw new BadRequestException(
        'Health expires_at must follow observed_at',
      );
    }
    const healthConfig = this.applications.getView(
      target.applicationId,
    )!.healthCheck;
    const current = this.repository.findHealth(target.id);
    const consecutiveFailures =
      input.status === 'unhealthy'
        ? (current?.consecutiveFailures ?? 0) + 1
        : 0;
    const consecutiveSuccesses =
      input.status === 'healthy' ? (current?.consecutiveSuccesses ?? 0) + 1 : 0;
    let status: RoutingTargetHealth['status'] = 'unknown';
    if (
      input.status === 'healthy' &&
      consecutiveSuccesses >= healthConfig.successThreshold
    ) {
      status = 'healthy';
    } else if (
      input.status === 'unhealthy' &&
      consecutiveFailures >= healthConfig.failureThreshold
    ) {
      status = 'unhealthy';
    } else if (input.status !== 'unknown' && current) {
      status = current.status;
    }
    return this.repository.saveHealth({
      targetId: target.id,
      deploymentId: target.deploymentId,
      status,
      observedAt,
      expiresAt,
      reason: input.reason ?? null,
      failureKind: input.failureKind ?? null,
      consecutiveFailures,
      consecutiveSuccesses,
      updatedAt: new Date().toISOString(),
    });
  }

  private requireApplication(id: string): void {
    if (!this.applications.find(id)) {
      throw new NotFoundException('Application not found');
    }
  }

  private requireAllowedTarget(
    deploymentId: string,
    kind: 'onprem' | 'cloud_run',
  ): void {
    const policy = this.deployments.findPolicyResult(deploymentId);
    if (
      !policy ||
      policy.decision === 'block' ||
      !policy.targets.includes(kind)
    ) {
      throw new ConflictException('Deployment policy does not allow target');
    }
    if (
      !policy.planHash ||
      !this.deployments.hasSuccessfulSignResult(deploymentId)
    ) {
      throw new ConflictException('Deployment policy is not signed');
    }
  }

  private cloudRunUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Cloud Run url is invalid');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new BadRequestException('Cloud Run url must be an HTTPS base URL');
    }
    return url.toString().replace(/\/$/, '');
  }

  private effectiveHealth(
    health: RoutingTargetHealth | null,
  ): RoutingTargetHealth | null {
    if (!health || health.expiresAt > new Date().toISOString()) return health;
    return { ...health, status: 'unknown' };
  }
}
