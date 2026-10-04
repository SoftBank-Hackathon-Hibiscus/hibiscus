import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { Application, HealthCheckConfig } from '../database/schema.js';
import { ApplicationRepository } from './application.repository.js';
import type {
  ApplicationEnvironmentVariableDto,
  CreateApplicationDto,
  UpdateApplicationEnvironmentDto,
  UpdateHealthCheckDto,
  UpdateApplicationSettingsDto,
  SettingsEnvironmentVariableDto,
} from './dto/application.dto.js';

@Injectable()
export class ApplicationService {
  constructor(
    private readonly repository: ApplicationRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  create(input: CreateApplicationDto) {
    this.validateEnvironment(input.environment);
    this.validateEnvironment(input.test_environment);
    const publicHost = `${input.slug}.${this.config.get('backend.gatewayBaseDomain', { infer: true })}`;
    if (this.repository.findByPublicHost(publicHost)) {
      throw new ConflictException('Application public host already exists');
    }
    const timestamp = new Date().toISOString();
    const application: Application = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      publicHost,
      sourcePath: input.source_path,
      imageRepo: input.image_repo,
      containerPort: input.container_port,
      repo: input.repo ?? null,
      defaultBranch: input.default_branch ?? null,
      testTemplate: input.test_template,
      requiresApproval: input.requires_approval,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const healthCheck: HealthCheckConfig = {
      applicationId: application.id,
      enabled: input.health_check.enabled,
      path: input.health_check.path,
      versionPath: input.health_check.version_path ?? null,
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
    return this.repository.create(
      application,
      healthCheck,
      input.environment.map(({ name, value }) => ({
        applicationId: application.id,
        name,
        value,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      input.test_environment.map(({ name, value }) => ({
        applicationId: application.id,
        name,
        value,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    );
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
      versionPath: input.version_path,
      method: input.method,
      intervalSeconds: input.interval_seconds,
      timeoutSeconds: input.timeout_seconds,
      successStatusMin: input.success_status_min,
      successStatusMax: input.success_status_max,
      successThreshold: input.success_threshold,
      failureThreshold: input.failure_threshold,
    });
  }

  updateEnvironment(id: string, input: UpdateApplicationEnvironmentDto) {
    if (!this.repository.find(id))
      throw new NotFoundException('Application not found');
    this.validateEnvironment(input.environment);
    const timestamp = new Date().toISOString();
    return {
      environment: this.repository.replaceEnvironment(
        id,
        input.environment.map(({ name, value }) => ({
          applicationId: id,
          name,
          value,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      ),
    };
  }

  updateTestEnvironment(id: string, input: UpdateApplicationEnvironmentDto) {
    if (!this.repository.find(id))
      throw new NotFoundException('Application not found');
    this.validateEnvironment(input.environment);
    const timestamp = new Date().toISOString();
    return {
      environment: this.repository.replaceTestEnvironment(
        id,
        input.environment.map(({ name, value }) => ({
          applicationId: id,
          name,
          value,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      ),
    };
  }

  updateSettings(id: string, input: UpdateApplicationSettingsDto) {
    this.get(id);
    const merge = (
      rows: SettingsEnvironmentVariableDto[],
      current: Record<string, string>,
    ) => {
      const result = rows.map((row) => {
        if (row.value === undefined && !(row.name in current))
          throw new BadRequestException(
            `New environment variable ${row.name} requires a value`,
          );
        return { name: row.name, value: row.value ?? current[row.name]! };
      });
      this.validateEnvironment(result);
      return Object.fromEntries(result.map((row) => [row.name, row.value]));
    };
    const runtime = merge(
      input.environment,
      this.repository.runtimeEnvironment(id),
    );
    const test = merge(
      input.test_environment,
      this.repository.testEnvironment(id),
    );
    const h = input.health_check;
    if (
      h.timeout_seconds > h.interval_seconds ||
      h.success_status_min > h.success_status_max
    )
      throw new BadRequestException('Invalid health check range');
    return this.repository.updateSettings(
      id,
      {
        enabled: h.enabled,
        path: h.path,
        versionPath: h.version_path ?? null,
        method: h.method,
        intervalSeconds: h.interval_seconds,
        timeoutSeconds: h.timeout_seconds,
        successStatusMin: h.success_status_min,
        successStatusMax: h.success_status_max,
        successThreshold: h.success_threshold,
        failureThreshold: h.failure_threshold,
      },
      runtime,
      test,
    );
  }

  private validateEnvironment(
    environment: ApplicationEnvironmentVariableDto[],
  ) {
    const names = environment.map(({ name }) => name);
    if (new Set(names).size !== names.length)
      throw new BadRequestException(
        'Environment variable names must be unique',
      );
    const reserved = names.find(
      (name) =>
        name === 'PORT' || name === 'HIB_RUN_ID' || name === 'HIB_DIGEST',
    );
    if (reserved)
      throw new BadRequestException(
        `Environment variable ${reserved} is managed by Hibiscus`,
      );
  }
}
