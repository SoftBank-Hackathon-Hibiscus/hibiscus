import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Application, HealthCheckConfig } from '../database/schema.js';
import { ApplicationRepository } from './application.repository.js';
import type {
  CreateApplicationDto,
  UpdateHealthCheckDto,
} from './dto/application.dto.js';

@Injectable()
export class ApplicationService {
  constructor(private readonly repository: ApplicationRepository) {}

  create(input: CreateApplicationDto) {
    const timestamp = new Date().toISOString();
    const application: Application = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      sourcePath: input.source_path,
      imageRepo: input.image_repo,
      containerPort: input.container_port,
      repo: input.repo ?? null,
      defaultBranch: input.default_branch ?? null,
      policyPath: input.policy_path ?? null,
      testTemplate: input.test_template,
      requiresApproval: input.requires_approval,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const healthCheck: HealthCheckConfig = {
      applicationId: application.id,
      enabled: input.health_check.enabled,
      path: input.health_check.path,
      method: input.health_check.method,
      intervalSeconds: input.health_check.interval_seconds,
      timeoutSeconds: input.health_check.timeout_seconds,
      successStatusMin: input.health_check.success_status_min,
      successStatusMax: input.health_check.success_status_max,
      successThreshold: input.health_check.success_threshold,
      failureThreshold: input.health_check.failure_threshold,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.repository.create(application, healthCheck);
  }

  list() {
    return this.repository.list();
  }

  get(id: string) {
    const view = this.repository.getView(id);
    if (!view) throw new NotFoundException('Application not found');
    return view;
  }

  updateHealthCheck(id: string, input: UpdateHealthCheckDto) {
    const current = this.get(id).healthCheck;
    const interval = input.interval_seconds ?? current.intervalSeconds;
    const timeout = input.timeout_seconds ?? current.timeoutSeconds;
    const statusMin = input.success_status_min ?? current.successStatusMin;
    const statusMax = input.success_status_max ?? current.successStatusMax;
    if (timeout > interval) {
      throw new BadRequestException(
        'timeout_seconds must not exceed interval_seconds',
      );
    }
    if (statusMin > statusMax) {
      throw new BadRequestException(
        'success_status_max must not be less than success_status_min',
      );
    }
    return this.repository.updateHealthCheck(id, {
      enabled: input.enabled,
      path: input.path,
      method: input.method,
      intervalSeconds: input.interval_seconds,
      timeoutSeconds: input.timeout_seconds,
      successStatusMin: input.success_status_min,
      successStatusMax: input.success_status_max,
      successThreshold: input.success_threshold,
      failureThreshold: input.failure_threshold,
    });
  }
}
