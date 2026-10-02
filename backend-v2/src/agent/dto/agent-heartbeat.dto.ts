import {
  Allow,
  Equals,
  IsISO8601,
  IsOptional,
  IsString,
} from 'class-validator';
import type { ServingContainer } from '../types/agent.type.js';

export class AgentIdParamDto {
  @IsString()
  id: string;
}

export class AgentHeartbeatDto {
  @Equals(1)
  schema_version: 1;
  @IsString()
  agent_id: string;
  @IsISO8601()
  updated_at: string;
  @Allow()
  serving: ServingContainer | null;
  @IsOptional()
  @IsString()
  public_url?: string | null;
}
