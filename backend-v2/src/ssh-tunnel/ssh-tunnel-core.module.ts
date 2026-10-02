import { Module } from '@nestjs/common';
import { SshTunnelEndpointService } from './ssh-tunnel-endpoint.service.js';
import { SshTunnelHostKeyService } from './ssh-tunnel-host-key.service.js';

@Module({
  providers: [SshTunnelHostKeyService, SshTunnelEndpointService],
  exports: [SshTunnelHostKeyService, SshTunnelEndpointService],
})
export class SshTunnelCoreModule {}
