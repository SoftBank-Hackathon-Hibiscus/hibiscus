import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { BackendConfig } from './config/configs/backend.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();

  const config = app.get(ConfigService<BackendConfig, true>);
  await app.listen(
    config.get('backend.port', { infer: true }),
    config.get('backend.host', { infer: true }),
  );
}
await bootstrap();
