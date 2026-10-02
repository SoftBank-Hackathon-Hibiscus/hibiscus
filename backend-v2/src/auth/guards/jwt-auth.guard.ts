import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth.service.js';
import { PUBLIC_ROUTE } from '../types/auth.type.js';
import type { AuthenticatedRequest } from '../types/auth.type.js';
import { AGENT_ROUTE } from '../../agent/types/agent.type.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(AGENT_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match)
      throw new UnauthorizedException('Bearer access token is required');
    request.user = await this.auth.verifyToken(match[1]!, 'access');
    return true;
  }
}
