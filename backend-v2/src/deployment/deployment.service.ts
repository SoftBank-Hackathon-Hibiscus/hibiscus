import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    trigger: 'manual' | 'webhook' | 'registration' = 'manual',
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
      {
        runtime: this.applications.runtimeEnvironment(applicationId),
        test: this.applications.testEnvironment(applicationId),
      },
    );
  }

  list(applicationId: string): Deployment[] {
    if (!this.applications.find(applicationId)) {
      throw new NotFoundException('Application not found');
    }
    return this.repository.list(applicationId);
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
    return view;
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
    return this.repository.find(id)!;
  }
}
