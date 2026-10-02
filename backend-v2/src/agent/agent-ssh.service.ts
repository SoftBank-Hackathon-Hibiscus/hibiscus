import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
import type { BackendConfig } from '../config/configs/backend.config.js';
import type { Agent } from '../database/schema.js';
import { AgentRepository } from './agent.repository.js';
import type { EnrollAgentSshDto } from './dto/agent-ssh.dto.js';

const { utils } = ssh2;

@Injectable()
export class AgentSshService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  issue() {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: this.hash(token),
      expiresAt: new Date(
        Date.now() +
          this.config.get('backend.sshEnrollmentTtlSeconds', {
            infer: true,
          }) *
            1_000,
      ).toISOString(),
    };
  }

  createEnrollment(agentId: string) {
    if (!this.repository.find(agentId)) {
      throw new NotFoundException('Agent not found');
    }
    const enrollment = this.issue();
    this.repository.update(agentId, {
      sshEnrollmentTokenHash: enrollment.tokenHash,
      sshEnrollmentExpiresAt: enrollment.expiresAt,
      sshEnrollmentUsedAt: null,
    });
    return this.enrollmentResponse(
      agentId,
      enrollment.token,
      enrollment.expiresAt,
    );
  }

  authenticateEnrollment(token: string): Agent {
    const agent = this.repository.authenticateSshEnrollment(
      this.hash(token),
      new Date().toISOString(),
    );
    if (!agent) {
      throw new UnauthorizedException(
        'SSH enrollment token is invalid, expired, or already used',
      );
    }
    return agent;
  }

  enroll(agentId: string, token: string, input: EnrollAgentSshDto) {
    const parsed = utils.parseKey(input.public_key.trim());
    if (parsed instanceof Error || parsed.type !== 'ssh-ed25519') {
      throw new BadRequestException('SSH public key must be ED25519');
    }
    if (parsed.isPrivateKey()) {
      throw new BadRequestException('SSH enrollment accepts only a public key');
    }
    const publicKeyBytes = parsed.getPublicSSH();
    const fingerprint = `SHA256:${createHash('sha256')
      .update(publicKeyBytes)
      .digest('base64')
      .replace(/=+$/, '')}`;
    const publicKey = `${parsed.type} ${publicKeyBytes.toString('base64')} ${parsed.comment || `hibiscus:${agentId}`}`;
    const enrolledAt = new Date().toISOString();
    const existing = this.repository.findBySshFingerprint(fingerprint);
    if (existing && existing.id !== agentId) {
      throw new ConflictException('SSH public key is already enrolled');
    }
    const agent = this.repository.consumeSshEnrollment(
      agentId,
      this.hash(token),
      publicKey,
      fingerprint,
      enrolledAt,
    );
    if (!agent) {
      throw new ConflictException('SSH enrollment token was already consumed');
    }
    return {
      agent_id: agent.id,
      fingerprint,
      enrolled_at: enrolledAt,
      ssh: this.connection(),
    };
  }

  revoke(agentId: string): void {
    this.repository.update(agentId, {
      sshEnrollmentTokenHash: null,
      sshEnrollmentExpiresAt: null,
      sshEnrollmentUsedAt: null,
      sshPublicKey: null,
      sshKeyFingerprint: null,
      sshEnrolledAt: null,
    });
  }

  enrollmentResponse(agentId: string, token: string, expiresAt: string) {
    return {
      agent_id: agentId,
      ssh_enrollment_token: token,
      expires_at: expiresAt,
      ssh: this.connection(),
    };
  }

  connection() {
    return {
      host: this.config.get('backend.sshHost', { infer: true }),
      port: this.config.get('backend.sshPort', { infer: true }),
      user: this.config.get('backend.sshUser', { infer: true }),
      host_key_sha256: this.config.get('backend.sshHostKeySha256', {
        infer: true,
      }),
    };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
