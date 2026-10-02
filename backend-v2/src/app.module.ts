import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { backendConfig } from './config/configs/backend.config.js';
import { authConfig } from './config/configs/auth.config.js';
import { deployConfig } from './config/configs/deploy.config.js';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClassSerializerInterceptor } from '@nestjs/common';
import { AgentModule } from './agent/agent.module.js';
import { ApplicationModule } from './application/application.module.js';
import { DeploymentModule } from './deployment/deployment.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UserModule } from './user/user.module.js';
import { GithubModule } from './github/github.module.js';
import { RoutingModule } from './routing/routing.module.js';
import { SshTunnelModule } from './ssh-tunnel/ssh-tunnel.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [backendConfig, authConfig, deployConfig],
    }),
    DeploymentModule,
    ApplicationModule,
    AgentModule,
    AuthModule,
    UserModule,
    GithubModule,
    RoutingModule,
    SshTunnelModule,
    GatewayModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
  ],
})
export class AppModule {}
