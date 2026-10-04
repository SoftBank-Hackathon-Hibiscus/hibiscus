import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendConfig } from '../config/configs/backend.config.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Agent } from '../database/schema.js';
import { ApplicationRepository } from '../application/application.repository.js';
import { AgentRepository } from './agent.repository.js';
import type { CreateAgentDto } from './dto/agent.dto.js';
import type { AgentHeartbeatDto } from './dto/agent-heartbeat.dto.js';
import { AgentSshService } from './agent-ssh.service.js';

@Injectable()
export class AgentService {
  private readonly tokenInvalidationListeners = new Set<
    (agentId: string) => void
  >();

  constructor(
    private readonly repository: AgentRepository,
    private readonly applications: ApplicationRepository,
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly ssh: AgentSshService,
  ) {}

  create(input: CreateAgentDto) {
    const token = randomBytes(32).toString('base64url');
    const sshEnrollment = this.ssh.issue();
    const timestamp = new Date().toISOString();
    const agent = this.repository.create({
      id: randomUUID(),
      name: input.name,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      sshEnrollmentTokenHash: sshEnrollment.tokenHash,
      sshEnrollmentExpiresAt: sshEnrollment.expiresAt,
      sshEnrollmentUsedAt: null,
      sshPublicKey: null,
      sshKeyFingerprint: null,
      sshEnrolledAt: null,
      status: 'registered',
      lastSeenAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      agent: this.publicAgent(agent),
      token,
      ...this.ssh.enrollmentResponse(
        agent.id,
        sshEnrollment.token,
        sshEnrollment.expiresAt,
      ),
    };
  }

  list() {
    return this.repository.list().map((agent) => this.publicAgent(agent));
  }

  get(id: string) {
    const agent = this.repository.find(id);
    if (!agent) throw new NotFoundException('Agent not found');
    return this.publicAgent(agent);
  }

  authenticate(token: string): Agent {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const agent = this.repository.authenticate(tokenHash);
    if (!agent)
      throw new UnauthorizedException('Agent token is invalid or revoked');
    return agent;
  }

  rotateToken(id: string) {
    this.get(id);
    const token = randomBytes(32).toString('base64url');
    const agent = this.repository.update(id, {
      tokenHash: createHash('sha256').update(token).digest('hex'),
      status: 'registered',
      lastSeenAt: null,
    });
    this.notifyTokenInvalidated(id);
    return { agent: this.publicAgent(agent), token };
  }

  revokeToken(id: string) {
    this.get(id);
    this.ssh.revoke(id);
    const agent = this.repository.update(id, { status: 'revoked' });
    this.notifyTokenInvalidated(id);
    return this.publicAgent(agent);
  }

  heartbeat(agentId: string, input: AgentHeartbeatDto) {
    if (input.agent_id !== agentId)
      throw new ForbiddenException(
        'Heartbeat agent_id does not match the authenticated agent',
      );
    const reportedAt = new Date(input.updated_at).toISOString();
    const previous = this.repository.heartbeat(agentId);
    if (previous && reportedAt < previous.reportedAt)
      throw new ConflictException('Heartbeat is older than the stored status');
    this.repository.saveHeartbeat({
      agentId,
      reportedAt,
      receivedAt: new Date().toISOString(),
      serving: input.serving ?? null,
      publicUrl: input.public_url ?? null,
    });
    return this.status(agentId);
  }

  status(id: string) {
    const agent = this.get(id);
    const heartbeat = this.repository.heartbeat(id);
    return {
      schema_version: 1,
      agent_id: id,
      status: agent.status,
      last_seen_at: agent.lastSeenAt,
      updated_at: heartbeat?.reportedAt ?? null,
      received_at: heartbeat?.receivedAt ?? null,
      serving: heartbeat?.serving ?? null,
      public_url: heartbeat?.publicUrl ?? null,
    };
  }

  forwards(agentId: string) {
    return this.repository.listForwards(agentId).map((target) => ({
      target_id: target.id,
      gateway_port: target.gatewayPort!,
      local_port: target.localPort!,
    }));
  }

  assign(applicationId: string, agentId: string) {
    if (!this.applications.find(applicationId)) {
      throw new NotFoundException('Application not found');
    }
    if (!this.repository.find(agentId)) {
      throw new NotFoundException('Agent not found');
    }
    this.repository.assign({
      applicationId,
      agentId,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    return this.applications.getView(applicationId)!;
  }

  unassign(applicationId: string, agentId: string) {
    if (!this.applications.find(applicationId))
      throw new NotFoundException('Application not found');
    this.get(agentId);
    this.repository.unassign(applicationId, agentId);
    return this.applications.getView(applicationId)!;
  }

  isAssigned(applicationId: string, agentId: string): boolean {
    return this.repository.isAssigned(agentId, applicationId);
  }

  onTokenInvalidated(listener: (agentId: string) => void): () => void {
    this.tokenInvalidationListeners.add(listener);
    return () => this.tokenInvalidationListeners.delete(listener);
  }

  private notifyTokenInvalidated(agentId: string): void {
    for (const listener of this.tokenInvalidationListeners) listener(agentId);
  }

  private publicAgent(agent: Agent) {
    return {
      id: agent.id,
      name: agent.name,
      status:
        agent.status === 'revoked' || !agent.lastSeenAt
          ? agent.status
          : Date.now() - Date.parse(agent.lastSeenAt) >=
              this.config.get('backend.agentOfflineAfterMs', { infer: true })
            ? 'offline'
            : 'online',
      lastSeenAt: agent.lastSeenAt,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      sshEnrolledAt: agent.sshEnrolledAt,
    };
  }
}
