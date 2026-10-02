import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { PUBLIC_ROUTE } from '../auth/types/auth.type.js';
import { AgentSshService } from './agent-ssh.service.js';
import { EnrollAgentSshDto } from './dto/agent-ssh.dto.js';
import { AgentSshEnrollmentGuard } from './guards/agent-ssh-enrollment.guard.js';
import type { AgentSshEnrollmentRequest } from './types/agent.type.js';

@Controller('agent/v1/ssh')
@SetMetadata(PUBLIC_ROUTE, true)
@UseGuards(AgentSshEnrollmentGuard)
export class AgentSshController {
  constructor(private readonly ssh: AgentSshService) {}

  @Post('enroll')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  enroll(
    @Req() request: AgentSshEnrollmentRequest,
    @Body() input: EnrollAgentSshDto,
  ) {
    return this.ssh.enroll(request.agent.id, request.sshEnrollmentToken, input);
  }
}
