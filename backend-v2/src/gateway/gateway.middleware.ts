import { HttpException, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { GatewayProxyService } from './gateway-proxy.service.js';
import { GatewayResolverService } from './gateway-resolver.service.js';

@Injectable()
export class GatewayMiddleware implements NestMiddleware {
  constructor(
    private readonly resolver: GatewayResolverService,
    private readonly proxy: GatewayProxyService,
  ) {}

  async use(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    let resolution;
    try {
      resolution = this.resolver.resolve(
        request.headers.host,
        request.originalUrl,
      );
      if (!resolution) {
        next();
        return;
      }
      await this.proxy.proxy(request, response, resolution);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpException ? error.getStatus() : 502;
      response.status(status).json({
        statusCode: status,
        message:
          error instanceof HttpException
            ? error.message
            : 'Gateway upstream is unavailable',
      });
    }
  }
}
