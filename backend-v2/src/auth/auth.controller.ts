import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  Res,
  SerializeOptions,
  SetMetadata,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import {
  GithubCallbackDto,
  RefreshTokenDto,
  TokenResponseDto,
} from './dto/auth.dto.js';
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_TTL_SECONDS,
  PUBLIC_ROUTE,
} from './types/auth.type.js';

@Controller('auth')
@SetMetadata(PUBLIC_ROUTE, true)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('github')
  @Header('Cache-Control', 'no-store')
  async github(@Res({ passthrough: true }) response: Response) {
    const { authorization_url, cookie } = await this.auth.startGithub();
    response.cookie(OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: this.auth.cookieSecure,
      sameSite: 'lax',
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_TTL_SECONDS * 1000,
    });
    return { authorization_url };
  }

  @Get('github/callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @SerializeOptions({ type: TokenResponseDto })
  async callback(
    @Query() input: GithubCallbackDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.clearCookie(OAUTH_COOKIE, {
      httpOnly: true,
      secure: this.auth.cookieSecure,
      sameSite: 'lax',
      path: OAUTH_COOKIE_PATH,
    });
    return this.auth.callback(input, request.headers.cookie);
  }

  @Post('refresh')
  @Header('Cache-Control', 'no-store')
  @SerializeOptions({ type: TokenResponseDto })
  refresh(@Body() input: RefreshTokenDto) {
    return this.auth.refresh(input.refresh_token);
  }
}
