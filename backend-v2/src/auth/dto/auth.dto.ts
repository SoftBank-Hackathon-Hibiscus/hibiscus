import { Exclude, Expose, Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserResponseDto } from '../../user/dto/user.dto.js';

export class GithubCallbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  code: string;

  @Matches(/^[A-Za-z0-9_-]{43}$/)
  state: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  iss?: string;
}

export class RefreshTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  refresh_token: string;
}

@Exclude()
export class TokenResponseDto {
  @Expose()
  access_token: string;
  @Expose()
  refresh_token: string;
  @Expose()
  token_type: string;
  @Expose()
  expires_in: number;
  @Expose()
  refresh_expires_in: number;
  @Expose()
  @Type(() => UserResponseDto)
  user: UserResponseDto;
}
