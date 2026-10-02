import { IsOptional, Matches } from 'class-validator';

const identifier = /^[A-Za-z0-9._-]{1,64}$/;

export class DeploymentIdParamDto {
  @Matches(identifier)
  id: string;
}

export class CreateDeploymentDto {
  @Matches(/^[0-9a-f]{7,40}$/)
  source_revision: string;

  @IsOptional()
  @Matches(/^sha256:[0-9a-f]{64}$/)
  image_digest?: string;
}

export class ApproveDeploymentDto {}
