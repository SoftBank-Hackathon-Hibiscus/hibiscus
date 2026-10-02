import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module.js';
import { DeploymentModule } from '../deployment/deployment.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { SshTunnelModule } from '../ssh-tunnel/ssh-tunnel.module.js';
import { FailoverService } from './failover.service.js';
import { HealthMonitorService } from './health-monitor.service.js';
import { TargetHealthProbeService } from './target-health-probe.service.js';

@Module({
  imports: [
    ApplicationModule,
    DeploymentModule,
    RoutingModule,
    SshTunnelModule,
  ],
  providers: [FailoverService, HealthMonitorService, TargetHealthProbeService],
  exports: [FailoverService, HealthMonitorService],
})
export class HealthModule {}
