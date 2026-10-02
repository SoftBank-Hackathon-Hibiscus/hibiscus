import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendConfig } from '../config/configs/backend.config.js';
import { SshTunnelHostKeyService } from './ssh-tunnel-host-key.service.js';

@Injectable()
export class SshTunnelEndpointService {
  private listeningPort?: number;

  constructor(
    private readonly config: ConfigService<BackendConfig, true>,
    private readonly hostKey: SshTunnelHostKeyService,
  ) {}

  setListeningPort(port: number): void {
    this.listeningPort = port;
  }

  connection() {
    return {
      host: this.config.get('backend.sshHost', { infer: true }),
      port:
        this.listeningPort ??
        this.config.get('backend.sshPort', { infer: true }),
      user: this.config.get('backend.sshUser', { infer: true }),
      host_key_sha256: this.hostKey.fingerprint(),
    };
  }
}
