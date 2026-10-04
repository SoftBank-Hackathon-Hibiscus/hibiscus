import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import {
  applicationAgents,
  applicationEnvironmentVariables,
  applicationTestEnvironmentVariables,
  applicationRuntimeLogs,
  deployments,
  deploymentEnvironmentVariables,
} from '../database/schema.js';
import type { SubmitRuntimeLogsDto, LogsQueryDto } from './dto/console.dto.js';
import { LogRedactionService } from './log-redaction.service.js';
@Injectable()
export class RuntimeLogsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redaction: LogRedactionService,
  ) {}
  secrets(applicationId: string, deploymentId: string): string[] {
    const db = this.database.db;
    return [
      ...db
        .select({ value: deploymentEnvironmentVariables.value })
        .from(deploymentEnvironmentVariables)
        .where(eq(deploymentEnvironmentVariables.deploymentId, deploymentId))
        .all()
        .map((r) => r.value),
      ...db
        .select({ value: applicationEnvironmentVariables.value })
        .from(applicationEnvironmentVariables)
        .where(eq(applicationEnvironmentVariables.applicationId, applicationId))
        .all()
        .map((r) => r.value),
      ...db
        .select({ value: applicationTestEnvironmentVariables.value })
        .from(applicationTestEnvironmentVariables)
        .where(
          eq(applicationTestEnvironmentVariables.applicationId, applicationId),
        )
        .all()
        .map((r) => r.value),
    ];
  }
  submit(agentId: string, input: SubmitRuntimeLogsDto) {
    const db = this.database.db;
    const deployment = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, input.run_id))
      .get();
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (
      !db
        .select()
        .from(applicationAgents)
        .where(
          and(
            eq(applicationAgents.applicationId, deployment.applicationId),
            eq(applicationAgents.agentId, agentId),
          ),
        )
        .get()
    )
      throw new ForbiddenException('Agent is not assigned to this application');
    const secrets = this.secrets(deployment.applicationId, deployment.id);
    const now = Date.now();
    if (input.entries.some((e) => Date.parse(e.timestamp) > now + 60_000))
      throw new BadRequestException('Log timestamp is in the future');
    db.transaction((tx) => {
      for (const entry of input.entries)
        tx.insert(applicationRuntimeLogs)
          .values({
            stream: entry.stream,
            level: entry.level,
            id: createHash('sha256')
              .update(`${agentId}:${deployment.id}:${entry.id}`)
              .digest('hex'),
            timestamp: new Date(entry.timestamp).toISOString(),
            applicationId: deployment.applicationId,
            deploymentId: deployment.id,
            agentId,
            message: this.redaction.redact(entry.message, secrets),
          })
          .onConflictDoNothing()
          .run();
      tx.delete(applicationRuntimeLogs)
        .where(
          lt(
            applicationRuntimeLogs.timestamp,
            new Date(now - 86_400_000).toISOString(),
          ),
        )
        .run();
      const excess = tx
        .select({ id: applicationRuntimeLogs.id })
        .from(applicationRuntimeLogs)
        .where(
          eq(applicationRuntimeLogs.applicationId, deployment.applicationId),
        )
        .orderBy(desc(applicationRuntimeLogs.timestamp))
        .limit(150)
        .offset(10_000)
        .all();
      if (excess.length)
        tx.delete(applicationRuntimeLogs)
          .where(
            inArray(
              applicationRuntimeLogs.id,
              excess.map((r) => r.id),
            ),
          )
          .run();
    });
    return { accepted: input.entries.length };
  }
  read(applicationId: string, deploymentId: string, query: LogsQueryDto) {
    const secrets = this.secrets(applicationId, deploymentId);
    const entries = this.database.db
      .select()
      .from(applicationRuntimeLogs)
      .where(
        and(
          eq(applicationRuntimeLogs.applicationId, applicationId),
          eq(applicationRuntimeLogs.deploymentId, deploymentId),
          gte(
            applicationRuntimeLogs.timestamp,
            new Date(Date.now() - query.seconds * 1000).toISOString(),
          ),
        ),
      )
      .orderBy(desc(applicationRuntimeLogs.timestamp))
      .limit(10_000)
      .all()
      .map(({ id, timestamp, stream, level, message }) => ({
        id,
        timestamp,
        stream,
        level,
        message: this.redaction.redact(message, secrets),
      }))
      .filter(
        (e) =>
          (query.level === 'all' || e.level === query.level) &&
          e.message.toLowerCase().includes(query.search.toLowerCase()),
      );
    return {
      entries: entries.slice(0, query.limit).reverse(),
      truncated: entries.length > query.limit,
      fetchedAt: new Date().toISOString(),
      source: 'onprem' as const,
    };
  }
}
