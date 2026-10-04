import {
  Allow,
  Equals,
  IsISO8601,
  IsOptional,
  IsString,
  IsIn,
  IsInt,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { ServingContainer } from '../types/agent.type.js';

export class AgentIdParamDto {
  @IsString()
  id: string;
}

export class AgentSshReportDto {
  @IsIn(['idle', 'connecting', 'connected', 'reconnecting', 'disconnected'])
  state: string;
  @IsInt() @Min(0) @Max(1000000) retry_count: number;
  @IsOptional() @IsISO8601() next_retry_at?: string;
  @IsOptional() @IsString() @MaxLength(500) last_error?: string;
  @IsOptional() @IsString() @MaxLength(64) last_error_code?: string;
  @IsOptional() @IsISO8601() last_error_at?: string;
  @IsString() @MaxLength(64) platform: string;
  @IsString() @MaxLength(64) arch: string;
  @IsString() @MaxLength(64) version: string;
}

export class AgentHeartbeatDto {
  @Equals(1)
  schema_version: 1;
  @IsString()
  agent_id: string;
  @IsISO8601()
  updated_at: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => AgentSshReportDto)
  ssh?: AgentSshReportDto;
  @Allow()
  serving: ServingContainer | null;
  @IsOptional()
  @IsString()
  public_url?: string | null;
}
