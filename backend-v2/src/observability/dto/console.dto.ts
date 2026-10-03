import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class TrafficQueryDto {
  @IsOptional() @Type(() => Number) @IsIn([60, 300, 900]) seconds = 300;
}
export class LogsQueryDto {
  @IsOptional() @Matches(/^[A-Za-z0-9._-]{1,64}$/) deployment_id?: string;
  @IsOptional() @IsIn(['onprem', 'cloud_run']) target: 'onprem' | 'cloud_run' =
    'onprem';
  @IsOptional() @Type(() => Number) @IsIn([300, 900, 3600]) seconds = 300;
  @IsOptional() @IsIn(['all', 'ERROR', 'WARN', 'INFO']) level = 'all';
  @IsOptional() @IsString() @MaxLength(200) search = '';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(150) limit = 150;
}
export class RuntimeLogDto {
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z0-9._:-]+$/) id: string;
  @IsISO8601() timestamp: string;
  @IsIn(['stdout', 'stderr']) stream: 'stdout' | 'stderr';
  @IsIn(['INFO', 'WARN', 'ERROR']) level: 'INFO' | 'WARN' | 'ERROR';
  @IsString() @MaxLength(4096) message: string;
}
export class SubmitRuntimeLogsDto {
  @Matches(/^[A-Za-z0-9._-]{1,64}$/) run_id: string;
  @IsArray()
  @ArrayMaxSize(150)
  @ValidateNested({ each: true })
  @Type(() => RuntimeLogDto)
  entries: RuntimeLogDto[];
}
