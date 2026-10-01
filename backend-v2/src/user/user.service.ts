import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { users } from '../database/schema.js';
import type { GithubProfile } from './interfaces/github-profile.interface.js';

@Injectable()
export class UserService {
  constructor(private readonly database: DatabaseService) {}

  find(id: string) {
    return this.database.db.select().from(users).where(eq(users.id, id)).get();
  }

  upsertGithub(profile: GithubProfile) {
    const timestamp = new Date().toISOString();
    return this.database.db
      .insert(users)
      .values({
        id: randomUUID(),
        githubId: String(profile.id),
        login: profile.login,
        name: profile.name ?? null,
        avatarUrl: profile.avatar_url ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: users.githubId,
        set: {
          login: profile.login,
          name: profile.name ?? null,
          avatarUrl: profile.avatar_url ?? null,
          updatedAt: timestamp,
        },
      })
      .returning()
      .get();
  }
}
