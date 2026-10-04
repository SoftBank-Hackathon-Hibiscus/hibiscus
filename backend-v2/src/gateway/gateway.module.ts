import {
  MiddlewareConsumer,
  Module,
  RequestMethod,
  type NestModule,
} from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module.js';
import { ApplicationModule } from '../application/application.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { SshTunnelModule } from '../ssh-tunnel/ssh-tunnel.module.js';
import { GatewayMiddleware } from './gateway.middleware.js';
import { GatewayProxyService } from './gateway-proxy.service.js';
import { GatewayResolverService } from './gateway-resolver.service.js';

@Module({
  imports: [
    ApplicationModule,
    RoutingModule,
    SshTunnelModule,
    ObservabilityModule,
  ],
  providers: [GatewayMiddleware, GatewayProxyService, GatewayResolverService],
})
export class GatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(GatewayMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
