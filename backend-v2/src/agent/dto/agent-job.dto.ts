import {
  Allow,
  Equals,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { JOB_ACTIONS } from '../types/agent.type.js';
import type {
  AgentJobResultPayload,
  CandidateContainer,
  JobAction,
  ServingContainer,
} from '../types/agent.type.js';

export class AgentJobParamDto {
  @IsString()
  @IsNotEmpty()
  jobId: string;
}

export class AgentAdminJobParamDto extends AgentJobParamDto {
  @IsString()
  @IsNotEmpty()
  id: string;
}

export class CreateAgentJobDto {
  @Equals(1)
  schema_version = 1 as const;
  @IsString()
  @IsNotEmpty()
  job_id: string;
  @IsString()
  @IsNotEmpty()
  run_id: string;
  @IsIn(JOB_ACTIONS)
  action: JobAction;
  @IsString()
  @IsNotEmpty()
  digest: string;
  @IsOptional()
  @IsString()
  agent_id?: string;
  @IsOptional()
  @IsString()
  image?: string;
  @IsOptional()
  @IsString()
  plan_hash?: string;
  @IsOptional()
  @IsString()
  to_digest?: string;
  @IsOptional()
  @Allow()
  environment?: Record<string, string>;
  @IsOptional()
  @IsISO8601()
  created_at?: string;
  @IsISO8601()
  deadline: string;
}

export class AgentJobResultDto implements AgentJobResultPayload {
  @Equals(1)
  schema_version: 1;
  @IsString()
  agent_id: string;
  @IsString()
  job_id: string;
  @IsString()
  run_id: string;
  @IsIn(JOB_ACTIONS)
  action: JobAction;
  @IsInt()
  @Min(1)
  attempt: number;
  @IsIn(['ok', 'error'])
  result: 'ok' | 'error';
  @Allow()
  candidate?: CandidateContainer;
  @Allow()
  check?: Record<string, unknown>;
  @Allow()
  previous?: ServingContainer;
  @Allow()
  serving?: ServingContainer;
  @IsOptional()
  @IsString()
  error?: string;
  @IsISO8601()
  finished_at: string;
}
