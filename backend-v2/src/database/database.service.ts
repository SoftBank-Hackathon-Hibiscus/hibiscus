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
  private readonly changes: BetterSqlite3.Statement<[], number>;
  private readonly dataVersion: BetterSqlite3.Statement<[], number>;
  readonly db: BetterSQLite3Database<typeof schema>;

  constructor(config: ConfigService<BackendConfig, true>) {
    const databaseFile = config.get('backend.databaseFile', { infer: true });
    mkdirSync(dirname(databaseFile), { recursive: true });
    this.client = new BetterSqlite3(databaseFile);
    this.client.pragma('journal_mode = WAL');
    this.client.pragma('foreign_keys = ON');
    this.changes = this.client
      .prepare<[], number>('SELECT total_changes()')
      .pluck();
    this.dataVersion = this.client
      .prepare<[], number>('PRAGMA data_version')
      .pluck();
    this.db = drizzle(this.client, { schema });
  }

  // Prepared scalar queries avoid ORM query construction on the gateway hot path.
  // total_changes covers our connection; data_version covers other connections.
  cacheRevision(): string {
    return `${this.changes.get()}:${this.dataVersion.get()}`;
  }

  onModuleInit(): void {
    migrate(this.db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
