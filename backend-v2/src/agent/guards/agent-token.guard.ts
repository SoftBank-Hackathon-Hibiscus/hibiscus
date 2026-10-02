import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AgentService } from '../agent.service.js';
import type { AgentRequest } from '../types/agent.type.js';

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(private readonly agents: AgentService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match)
      throw new UnauthorizedException('Bearer agent token is required');
    request.agent = this.agents.authenticate(match[1]!);
    return true;
  }
}
