import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';
import type { AuthContext } from 'ssh2';
import { AgentRepository } from '../agent/agent.repository.js';
import type { BackendConfig } from '../config/configs/backend.config.js';

const { utils } = ssh2;

@Injectable()
export class SshTunnelAuthService {
  constructor(
    private readonly agents: AgentRepository,
    private readonly config: ConfigService<BackendConfig, true>,
  ) {}

  authenticate(context: AuthContext): string | undefined {
    if (
      context.method !== 'publickey' ||
      !this.equal(
        Buffer.from(context.username),
        Buffer.from(this.config.get('backend.sshUser', { infer: true })),
      ) ||
      context.key.algo !== 'ssh-ed25519'
    ) {
      return undefined;
    }

    const fingerprint = `SHA256:${createHash('sha256')
      .update(context.key.data)
      .digest('base64')
      .replace(/=+$/, '')}`;
    const agent = this.agents.findBySshFingerprint(fingerprint);
    if (!agent?.sshPublicKey || agent.status === 'revoked') return undefined;

    const publicKey = utils.parseKey(agent.sshPublicKey);
    if (
      publicKey instanceof Error ||
      publicKey.type !== 'ssh-ed25519' ||
      !this.equal(context.key.data, publicKey.getPublicSSH())
    ) {
      return undefined;
    }
    if (
      context.signature &&
      (!context.blob ||
        !publicKey.verify(context.blob, context.signature, context.hashAlgo))
    ) {
      return undefined;
    }
    return agent.id;
  }

  canForward(agentId: string, bindAddress: string, bindPort: number): boolean {
    return (
      bindAddress === '127.0.0.1' &&
      this.agents
        .listForwards(agentId)
        .some((target) => target.gatewayPort === bindPort)
    );
  }

  private equal(input: Buffer, allowed: Buffer): boolean {
    if (input.length !== allowed.length) return false;
    return timingSafeEqual(input, allowed);
  }
}
