import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const identifier = /^[A-Za-z0-9._-]{1,128}$/;
const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export class ApplicationRoutingParamDto {
  @Matches(identifier)
  id: string;
}

export class CreateRoutingTargetDto {
  @Matches(identifier)
  deployment_id: string;

  @IsIn(['onprem', 'cloud_run'])
  kind: 'onprem' | 'cloud_run';

  @IsOptional()
  @Matches(identifier)
  agent_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  local_port?: number;

  @IsOptional()
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsBoolean()
  enabled = true;
}

export class UpdateApplicationRouteDto {
  @Matches(identifier)
  target_id: string;

  @IsInt()
  @Min(0)
  expected_revision: number;

  @IsOptional()
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  reason?: string;
}
