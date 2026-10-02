import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BackendConfig } from '../config/configs/backend.config.js';
import * as schema from './schema.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly client: BetterSqlite3.Database;
  readonly db: BetterSQLite3Database<typeof schema>;

  constructor(config: ConfigService<BackendConfig, true>) {
    const databaseFile = config.get('backend.databaseFile', { infer: true });
    mkdirSync(dirname(databaseFile), { recursive: true });
    this.client = new BetterSqlite3(databaseFile);
    this.client.pragma('journal_mode = WAL');
    this.client.pragma('foreign_keys = ON');
    this.db = drizzle(this.client, { schema });
  }

  onModuleInit(): void {
    migrate(this.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
