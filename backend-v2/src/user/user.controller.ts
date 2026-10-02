import { Controller, Get, Req, SerializeOptions } from '@nestjs/common';
import { UserResponseDto } from './dto/user.dto.js';
import type { AuthenticatedRequest } from '../auth/types/auth.type.js';

@Controller('users')
export class UserController {
  @Get('me')
  @SerializeOptions({ type: UserResponseDto })
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }
}
