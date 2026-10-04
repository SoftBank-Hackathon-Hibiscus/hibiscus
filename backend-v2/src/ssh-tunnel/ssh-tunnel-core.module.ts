import { DatabaseModule } from '../database/database.module.js';
import { SshConnectionStateService } from './ssh-connection-state.service.js';
import { Module } from '@nestjs/common';
import { SshTunnelEndpointService } from './ssh-tunnel-endpoint.service.js';
import { SshTunnelHostKeyService } from './ssh-tunnel-host-key.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    SshConnectionStateService,
    SshTunnelHostKeyService,
    SshTunnelEndpointService,
  ],
  exports: [
    SshConnectionStateService,
    SshTunnelHostKeyService,
    SshTunnelEndpointService,
  ],
})
export class SshTunnelCoreModule {}
