import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import ssh2 from 'ssh2';
import type { BackendConfig } from '../config/configs/backend.config.js';

const { utils } = ssh2;

@Injectable()
export class SshTunnelHostKeyService implements OnModuleInit {
  private privateKey?: string;
  private hostKeyFingerprint?: string;

  constructor(private readonly config: ConfigService<BackendConfig, true>) {}

  async onModuleInit(): Promise<void> {
    await this.ensure();
  }

  key(): string {
    if (!this.privateKey) throw new Error('SSH host key is not initialized');
    return this.privateKey;
  }

  fingerprint(): string {
    if (!this.hostKeyFingerprint) {
      throw new Error('SSH host key is not initialized');
    }
    return this.hostKeyFingerprint;
  }

  private async ensure(): Promise<void> {
    const path = this.config.get('backend.sshHostKeyFile', { infer: true });
    let privateKey: string;
    try {
      privateKey = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      privateKey = utils.generateKeyPairSync('ed25519', {
        comment: 'hibiscus-backend',
      }).private;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporary, privateKey, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    }

    const parsed = utils.parseKey(privateKey);
    if (
      parsed instanceof Error ||
      !parsed.isPrivateKey() ||
      parsed.type !== 'ssh-ed25519'
    ) {
      throw new Error('SSH host key must be an ED25519 private key');
    }
    this.privateKey = privateKey;
    this.hostKeyFingerprint = `SHA256:${createHash('sha256')
      .update(parsed.getPublicSSH())
      .digest('base64')
      .replace(/=+$/, '')}`;
  }
}
