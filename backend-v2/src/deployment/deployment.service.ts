import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { redactDeploymentView } from '../infrastructure/command-diagnostics.js';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { Deployment } from '../database/schema.js';
import { ApplicationRepository } from '../application/application.repository.js';
import { DeploymentRepository } from './deployment.repository.js';
import type { CreateDeploymentDto } from './dto/deployment.dto.js';

@Injectable()
export class DeploymentService {
  constructor(
    private readonly repository: DeploymentRepository,
    private readonly applications: ApplicationRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  create(
    applicationId: string,
    input: CreateDeploymentDto,
    requesterId: string,
    trigger: Deployment['trigger'] = 'manual',
    environment?: {
      runtime: Record<string, string>;
      test: Record<string, string>;
    },
  ) {
    const application = this.applications.find(applicationId);
    if (!application) throw new NotFoundException('Application not found');

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const digest =
      input.image_digest ??
      `sha256:${createHash('sha256').update(`placeholder:${id}`).digest('hex')}`;

    return this.repository.create(
      {
        id,
        applicationId,
        trigger,
        sourceRevision: input.source_revision,
        // Webhook authentication verifies the request, not the built/tested image.
        sourceRevisionVerified: false,
        imageDigest: digest,
        digestSource: input.image_digest ? 'registry' : 'placeholder',
        requester: requesterId,
        approver: null,
        decision: null,
        status: 'queued',
        currentStage: null,
        error: null,
        workDir: '', // 기존 DB 행의 경로 메타데이터만 보존. 새 결과는 DB에 저장합니다.
        executionMode: this.config.get('backend.stageMode', { infer: true }),
        deploymentPerformed: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      environment ?? {
        runtime: this.applications.runtimeEnvironment(applicationId),
        test: this.applications.testEnvironment(applicationId),
      },
    );
  }

  list(applicationId: string): Deployment[] {
    if (!this.applications.find(applicationId)) {
      throw new NotFoundException('Application not found');
    }
    return this.repository
      .list(applicationId)
      .map((deployment) => this.redacted(deployment.id, deployment));
  }

  latestSourceRevision(applicationId: string): string {
    const latest = this.list(applicationId)[0];
    if (!latest)
      throw new ConflictException(
        'Application has no deployment source to redeploy',
      );
    return latest.sourceRevision;
  }

  get(id: string) {
    const view = this.repository.getView(id);
    if (!view) throw new NotFoundException('Deployment not found');
    return this.redacted(id, view);
  }

  private redacted<T>(id: string, value: T): T {
    const deployment = this.repository.find(id);
    const secrets = [
      ...Object.values(this.repository.environment(id, 'runtime')),
      ...Object.values(this.repository.environment(id, 'test')),
      ...(deployment
        ? Object.values(
            this.applications.runtimeEnvironment(deployment.applicationId),
          )
        : []),
      ...(deployment
        ? Object.values(
            this.applications.testEnvironment(deployment.applicationId),
          )
        : []),
    ];
    return redactDeploymentView(value, secrets);
  }

  cancel(id: string): Deployment {
    const deployment = this.repository.find(id);
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (deployment.status === 'cancelled') return this.redacted(id, deployment);
    if (!this.repository.cancel(id)) {
      throw new ConflictException(
        'Deployment cannot be cancelled after deploy starts or after completion',
      );
    }
    return this.redacted(id, this.repository.find(id)!);
  }

  rollback(id: string, requesterId: string): Deployment {
    const source = this.repository.find(id);
    if (!source) throw new NotFoundException('Deployment not found');
    if (source.status !== 'succeeded' || !source.deploymentPerformed) {
      throw new ConflictException(
        'Rollback requires a successfully deployed version',
      );
    }
    const active = this.repository.findActive(source.applicationId);
    if (!active || active.version <= source.version) {
      throw new ConflictException(
        'Rollback target must be older than the active deployment',
      );
    }
    if (
      this.repository
        .list(source.applicationId)
        .some((deployment) =>
          ['queued', 'running', 'awaiting_approval'].includes(
            deployment.status,
          ),
        )
    ) {
      throw new ConflictException(
        'Cancel or finish pending deployments before rollback',
      );
    }
    return this.create(
      source.applicationId,
      { source_revision: source.sourceRevision },
      requesterId,
      'rollback',
      {
        runtime: this.repository.environment(id, 'runtime'),
        test: this.repository.environment(id, 'test'),
      },
    );
  }

  approve(id: string, approverId: string): Deployment {
    const deployment = this.repository.find(id);
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (deployment.requester === approverId) {
      throw new ForbiddenException(
        'Requester cannot approve their own deployment',
      );
    }
    if (!this.repository.approve(id, approverId)) {
      throw new ConflictException('Deployment is not awaiting approval');
    }
    return this.redacted(id, this.repository.find(id)!);
  }
}
