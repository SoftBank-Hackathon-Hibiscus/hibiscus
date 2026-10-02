import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

const identifier = /^[A-Za-z0-9._-]{1,64}$/;

export class CreateAgentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;
}

export class AssignAgentParamDto {
  @Matches(identifier)
  id: string;

  @Matches(identifier)
  agentId: string;
}
