import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreateApplicationDto } from '../../application/dto/application.dto.js';

export class GithubPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  per_page = 30;
}
export class GithubRepositoriesQueryDto extends GithubPageDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  installation_id: number;
}
export class GithubRepositoryParamDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  repositoryId: number;
}
export class GithubApplicationDto extends CreateApplicationDto {
  source_path = 'github';
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  installation_id: number;
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  repository_id: number;
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  branch: string;
  @IsOptional()
  @IsBoolean()
  auto_deploy = true;
}
export class GithubBranchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  branch: string;
  @IsOptional()
  @IsBoolean()
  auto_deploy?: boolean;
}

export class GithubIdDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  id: number;
}
export class GithubRepositoryDto extends GithubIdDto {
  @Matches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  full_name: string;
  @IsString()
  @IsNotEmpty()
  default_branch: string;
  @IsBoolean()
  private: boolean;
}
export class GithubBranchResponseDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
export class GithubPushDto {
  @IsString()
  @IsNotEmpty()
  ref: string;
  @Matches(/^[a-f0-9]{40}$/)
  after: string;
  @IsBoolean()
  deleted: boolean;
  @ValidateNested()
  @Type(() => GithubIdDto)
  repository: GithubIdDto;
  @ValidateNested()
  @Type(() => GithubIdDto)
  installation: GithubIdDto;
}
