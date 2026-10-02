import { Exclude, Expose } from 'class-transformer';
@Exclude()
export class UserResponseDto {
  @Expose()
  id: string;
  @Expose()
  githubId: string;
  @Expose()
  login: string;
  @Expose()
  name: string | null;
  @Expose()
  avatarUrl: string | null;
  @Expose()
  createdAt: string;
  @Expose()
  updatedAt: string;
}
