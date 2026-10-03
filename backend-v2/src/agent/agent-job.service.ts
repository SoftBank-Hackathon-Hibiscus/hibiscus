import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { AgentJob } from '../database/schema.js';
import { DeploymentRepository } from '../deployment/deployment.repository.js';
import { canonicalJson } from '../deployment/types/deployment.type.js';
import { ApplicationRepository } from '../application/application.repository.js';
import { AgentRepository } from './agent.repository.js';
import { AgentJobRepository } from './agent-job.repository.js';
import type {
  CreateAgentJobDto,
  AgentJobResultDto,
} from './dto/agent-job.dto.js';

@Injectable()
export class AgentJobService {
  constructor(
    private readonly jobs: AgentJobRepository,
    private readonly agents: AgentRepository,
    private readonly deployments: DeploymentRepository,
    private readonly applications: ApplicationRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  create(agentId: string, input: CreateAgentJobDto) {
    const agent = this.requiredAgent(agentId);
    if (agent.status === 'revoked')
      throw new ConflictException('Agent token is revoked');
    if (input.agent_id && input.agent_id !== agentId)
      throw new ForbiddenException(
        'Job agent_id does not match the target agent',
      );
    const deployment = this.deployments.find(input.run_id);
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (!this.agents.isAssigned(agentId, deployment.applicationId))
      throw new ForbiddenException('Agent is not assigned to this application');
    if (input.digest !== deployment.imageDigest)
      throw new ConflictException('Job digest does not match the deployment');
    if (
      input.action === 'candidate' &&
      (!input.image ||
        !input.plan_hash ||
        !input.image.endsWith(`@${input.digest}`))
    )
      throw new BadRequestException(
        'Candidate job requires an image matching the digest and a plan_hash',
      );
    if (input.action === 'rollback' && !input.to_digest)
      throw new BadRequestException('Rollback job requires to_digest');
    const job: AgentJob = {
      id: input.job_id,
      agentId,
      runId: input.run_id,
      action: input.action,
      digest: input.digest,
      image: input.image ?? null,
      planHash: input.plan_hash ?? null,
      toDigest: input.to_digest ?? null,
      environment: input.environment ?? {},
      createdAt: input.created_at
        ? new Date(input.created_at).toISOString()
        : new Date().toISOString(),
      deadline: new Date(input.deadline).toISOString(),
      status: 'queued',
      attempt: 0,
      leaseUntil: null,
    };
    const existing = this.jobs.find(job.id);
    if (existing) return this.sameCreation(existing, job);
    if (Date.parse(job.deadline) <= Date.now())
      throw new BadRequestException('Job deadline must be in the future');
    return this.sameCreation(this.jobs.create(job), job);
  }

  next(agentId: string) {
    const job = this.jobs.claim(
      agentId,
      this.config.get('backend.agentCandidateLeaseMs', { infer: true }),
      this.config.get('backend.agentActionLeaseMs', { infer: true }),
    );
    return job ? this.contract(job, true) : undefined;
  }

  submit(agentId: string, jobId: string, input: AgentJobResultDto) {
    this.jobs.expire(agentId);
    const job = this.requiredJob(agentId, jobId);
    if (
      input.agent_id !== agentId ||
      input.job_id !== job.id ||
      input.run_id !== job.runId ||
      input.action !== job.action
    )
      throw new ConflictException(
        'Job result does not match the authenticated agent or job',
      );
    if (input.result === 'error' && !input.error)
      throw new BadRequestException(
        'Failed job result requires an error message',
      );
    if (input.result === 'ok') {
      if (job.action === 'candidate' && input.candidate?.digest !== job.digest)
        throw new ConflictException('Candidate digest does not match the job');
      const targetDigest =
        job.action === 'rollback' ? job.toDigest : job.digest;
      if (
        ['activate', 'rollback'].includes(job.action) &&
        input.serving?.digest !== targetDigest
      )
        throw new ConflictException(
          'Serving digest does not match the job target',
        );
    }
    const contentHash = createHash('sha256')
      .update(canonicalJson(input))
      .digest('hex');
    const existing = this.jobs.result(jobId, input.attempt);
    if (existing) {
      if (existing.contentHash !== contentHash)
        throw new ConflictException(
          'A different result is already stored for this job attempt',
        );
      return existing.payload;
    }
    if (
      !this.jobs.complete(agentId, {
        jobId,
        attempt: input.attempt,
        payload: input,
        contentHash,
        receivedAt: new Date().toISOString(),
      })
    ) {
      const concurrent = this.jobs.result(jobId, input.attempt);
      if (concurrent?.contentHash === contentHash) return concurrent.payload;
      throw new ConflictException(
        'Job lease is missing, expired, or belongs to another attempt',
      );
    }
    return input;
  }

  list(agentId: string) {
    this.requiredAgent(agentId);
    return this.jobs
      .list(agentId)
      .map((job) => ({ job: this.contract(job), status: job.status }));
  }

  get(agentId: string, jobId: string) {
    this.jobs.expire(agentId);
    const job = this.requiredJob(agentId, jobId);
    return {
      job: this.contract(job),
      status: job.status,
      results: this.jobs.results(jobId).map((result) => ({
        payload: result.payload,
        received_at: result.receivedAt,
      })),
    };
  }

  private requiredAgent(id: string) {
    const agent = this.agents.find(id);
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  private requiredJob(agentId: string, jobId: string): AgentJob {
    const job = this.jobs.find(jobId);
    if (!job || job.agentId !== agentId)
      throw new NotFoundException('Agent job not found');
    return job;
  }

  private sameCreation(stored: AgentJob, requested: AgentJob) {
    const identity = (job: AgentJob) => ({
      id: job.id,
      agentId: job.agentId,
      runId: job.runId,
      action: job.action,
      digest: job.digest,
      image: job.image,
      planHash: job.planHash,
      toDigest: job.toDigest,
      environment: job.environment,
      deadline: job.deadline,
    });
    if (canonicalJson(identity(stored)) !== canonicalJson(identity(requested)))
      throw new ConflictException('job_id is already used by a different job');
    return { job: this.contract(stored), status: stored.status };
  }

  private contract(job: AgentJob, includeEnvironment = false) {
    const deployment = this.deployments.find(job.runId)!;
    const application = this.applications.getView(deployment.applicationId)!;
    const health = application.healthCheck;
    return {
      schema_version: 1,
      job_id: job.id,
      agent_id: job.agentId,
      run_id: job.runId,
      action: job.action,
      digest: job.digest,
      ...(job.image ? { image: job.image } : {}),
      ...(job.planHash ? { plan_hash: job.planHash } : {}),
      ...(job.toDigest ? { to_digest: job.toDigest } : {}),
      runtime: {
        container_port: application.application.containerPort,
        ...(includeEnvironment
          ? {
              environment: job.environment,
            }
          : {}),
      },
      health_check: {
        enabled: health.enabled,
        path: health.path,
        ...(health.versionPath ? { version_path: health.versionPath } : {}),
        method: health.method,
        interval_seconds: health.intervalSeconds,
        timeout_seconds: health.timeoutSeconds,
        success_status_min: health.successStatusMin,
        success_status_max: health.successStatusMax,
        success_threshold: health.successThreshold,
        failure_threshold: health.failureThreshold,
      },
      created_at: job.createdAt,
      deadline: job.deadline,
      attempt: job.attempt,
      lease_until: job.leaseUntil,
    };
  }
}
