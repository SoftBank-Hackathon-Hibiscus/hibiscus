import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class EnrollAgentSshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4_096)
  public_key: string;
}
