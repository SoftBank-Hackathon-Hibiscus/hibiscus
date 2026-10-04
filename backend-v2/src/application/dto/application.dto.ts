import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  ValidateIf,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

@ValidatorConstraint({ name: 'timeoutWithinInterval', async: false })
class TimeoutWithinInterval implements ValidatorConstraintInterface {
  validate(timeout: number | undefined, args: ValidationArguments): boolean {
    const object = args.object as {
      interval_seconds?: number;
    };
    return (
      timeout === undefined ||
      object.interval_seconds === undefined ||
      timeout <= object.interval_seconds
    );
  }

  defaultMessage(): string {
    return 'timeout_seconds must not exceed interval_seconds';
  }
}

@ValidatorConstraint({ name: 'validSuccessStatusRange', async: false })
class ValidSuccessStatusRange implements ValidatorConstraintInterface {
  validate(maximum: number | undefined, args: ValidationArguments): boolean {
    const object = args.object as {
      success_status_min?: number;
    };
    return (
      maximum === undefined ||
      object.success_status_min === undefined ||
      maximum >= object.success_status_min
    );
  }

  defaultMessage(): string {
    return 'success_status_max must not be less than success_status_min';
  }
}

export class IdParamDto {
  @Matches(/^[A-Za-z0-9._-]{1,64}$/)
  id: string;
}

export class HealthCheckDto {
  @IsBoolean()
  enabled = true;

  @IsString()
  @Matches(/^\/(?!\/)[^\s?#]*$/)
  @MaxLength(256)
  path = '/health';

  @IsOptional()
  @IsString()
  @Matches(/^\/(?!\/)[^\s?#]*$/)
  @MaxLength(256)
  version_path?: string;

  @IsIn(['GET', 'HEAD'])
  method: 'GET' | 'HEAD' = 'GET';

  @IsInt()
  @Min(1)
  @Max(300)
  interval_seconds = 5;

  @IsInt()
  @Min(1)
  @Max(60)
  @Validate(TimeoutWithinInterval)
  timeout_seconds = 2;

  @IsInt()
  @Min(100)
  @Max(599)
  success_status_min = 200;

  @IsInt()
  @Min(100)
  @Max(599)
  @Validate(ValidSuccessStatusRange)
  success_status_max = 399;

  @IsInt()
  @Min(1)
  @Max(20)
  success_threshold = 1;

  @IsInt()
  @Min(1)
  @Max(20)
  failure_threshold = 3;
}

export class UpdateHealthCheckDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\/(?!\/)[^\s?#]*$/)
  @MaxLength(256)
  path?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\/(?!\/)[^\s?#]*$/)
  @MaxLength(256)
  version_path?: string | null;

  @IsOptional()
  @IsIn(['GET', 'HEAD'])
  method?: 'GET' | 'HEAD';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  interval_seconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  @Validate(TimeoutWithinInterval)
  timeout_seconds?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(599)
  success_status_min?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(599)
  @Validate(ValidSuccessStatusRange)
  success_status_max?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  success_threshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  failure_threshold?: number;
}

export class ApplicationEnvironmentVariableDto {
  @Matches(/^[A-Z_][A-Z0-9_]{0,63}$/)
  name: string;

  @IsString()
  @MaxLength(4096)
  value: string;
}

export class CreateApplicationDto {
  @trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(64)
  slug: string;

  @trim()
  @IsString()
  @IsNotEmpty()
  source_path: string;

  @trim()
  @IsString()
  @IsNotEmpty()
  image_repo: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  container_port = 8080;

  @IsOptional()
  @Matches(/^[^/\s]+\/[^/\s]+$/)
  repo?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  default_branch?: string;

  @IsOptional()
  @IsIn(['allow', 'block-test-failed'])
  test_template: 'allow' | 'block-test-failed' = 'allow';

  @IsOptional()
  @IsBoolean()
  requires_approval = false;

  @IsOptional()
  @ValidateNested()
  @Type(() => HealthCheckDto)
  health_check: HealthCheckDto = new HealthCheckDto();

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ApplicationEnvironmentVariableDto)
  environment: ApplicationEnvironmentVariableDto[] = [];

  /** Parity replay/health 전용 값. 운영 DB 자격 증명을 사용하지 않는다. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ApplicationEnvironmentVariableDto)
  test_environment: ApplicationEnvironmentVariableDto[] = [];
}

export class UpdateApplicationEnvironmentDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ApplicationEnvironmentVariableDto)
  environment: ApplicationEnvironmentVariableDto[];
}

export class SettingsEnvironmentVariableDto {
  @Matches(/^[A-Z_][A-Z0-9_]{0,63}$/)
  name: string;

  /** Omitted value preserves an existing secret. Empty string explicitly replaces it. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(4096)
  value?: string;
}
export class UpdateApplicationSettingsDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => HealthCheckDto)
  health_check: HealthCheckDto;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SettingsEnvironmentVariableDto)
  environment: SettingsEnvironmentVariableDto[];

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SettingsEnvironmentVariableDto)
  test_environment: SettingsEnvironmentVariableDto[];
}
