import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AgentSshService } from '../agent-ssh.service.js';
import type { AgentSshEnrollmentRequest } from '../types/agent.type.js';

@Injectable()
export class AgentSshEnrollmentGuard implements CanActivate {
  constructor(private readonly ssh: AgentSshService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<AgentSshEnrollmentRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.authorization ?? '',
    );
    if (!match) {
      throw new UnauthorizedException(
        'Bearer SSH enrollment token is required',
      );
    }
    request.agent = this.ssh.authenticateEnrollment(match[1]!);
    request.sshEnrollmentToken = match[1]!;
    return true;
  }
}
