import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lte, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  agentJobs,
  agentJobResults,
  type AgentJob,
  type AgentJobResult,
} from '../database/schema.js';

@Injectable()
export class AgentJobRepository {
  constructor(private readonly database: DatabaseService) {}

  create(job: AgentJob): AgentJob {
    this.database.db.insert(agentJobs).values(job).onConflictDoNothing().run();
    return this.find(job.id)!;
  }

  find(id: string): AgentJob | undefined {
    return this.database.db
      .select()
      .from(agentJobs)
      .where(eq(agentJobs.id, id))
      .get();
  }

  list(agentId: string): AgentJob[] {
    this.expire(agentId);
    return this.database.db
      .select()
      .from(agentJobs)
      .where(eq(agentJobs.agentId, agentId))
      .orderBy(asc(agentJobs.createdAt), asc(agentJobs.id))
      .all();
  }

  results(jobId: string): AgentJobResult[] {
    return this.database.db
      .select()
      .from(agentJobResults)
      .where(eq(agentJobResults.jobId, jobId))
      .orderBy(asc(agentJobResults.attempt))
      .all();
  }

  result(jobId: string, attempt: number): AgentJobResult | undefined {
    return this.database.db
      .select()
      .from(agentJobResults)
      .where(
        and(
          eq(agentJobResults.jobId, jobId),
          eq(agentJobResults.attempt, attempt),
        ),
      )
      .get();
  }

  expire(agentId: string, now = new Date().toISOString()): void {
    this.database.db
      .update(agentJobs)
      .set({ status: 'expired' })
      .where(
        and(
          eq(agentJobs.agentId, agentId),
          inArray(agentJobs.status, ['queued', 'leased']),
          lte(agentJobs.deadline, now),
        ),
      )
      .run();
  }

  claim(
    agentId: string,
    candidateLeaseMs: number,
    actionLeaseMs: number,
  ): AgentJob | undefined {
    return this.database.db.transaction(
      (tx) => {
        const now = new Date().toISOString();
        this.expire(agentId, now);
        const active = tx
          .select()
          .from(agentJobs)
          .where(
            and(
              eq(agentJobs.agentId, agentId),
              eq(agentJobs.status, 'leased'),
              gt(agentJobs.leaseUntil, now),
            ),
          )
          .get();
        if (active) return undefined;
        const job = tx
          .select()
          .from(agentJobs)
          .where(
            and(
              eq(agentJobs.agentId, agentId),
              gt(agentJobs.deadline, now),
              or(
                eq(agentJobs.status, 'queued'),
                and(
                  eq(agentJobs.status, 'leased'),
                  lte(agentJobs.leaseUntil, now),
                ),
              ),
            ),
          )
          .orderBy(asc(agentJobs.createdAt), asc(agentJobs.id))
          .limit(1)
          .get();
        if (!job) return undefined;
        const duration =
          job.action === 'candidate' ? candidateLeaseMs : actionLeaseMs;
        const leaseUntil = new Date(
          Math.min(Date.parse(now) + duration, Date.parse(job.deadline)),
        ).toISOString();
        return tx
          .update(agentJobs)
          .set({ status: 'leased', attempt: job.attempt + 1, leaseUntil })
          .where(eq(agentJobs.id, job.id))
          .returning()
          .get();
      },
      { behavior: 'immediate' },
    );
  }

  complete(agentId: string, result: AgentJobResult): boolean {
    return this.database.db.transaction(
      (tx) => {
        const changed = tx
          .update(agentJobs)
          .set({
            status: result.payload.result === 'ok' ? 'succeeded' : 'failed',
          })
          .where(
            and(
              eq(agentJobs.id, result.jobId),
              eq(agentJobs.agentId, agentId),
              eq(agentJobs.status, 'leased'),
              eq(agentJobs.attempt, result.attempt),
              gt(agentJobs.leaseUntil, result.receivedAt),
              gt(agentJobs.deadline, result.receivedAt),
            ),
          )
          .run().changes;
        if (!changed) return false;
        tx.insert(agentJobResults).values(result).run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }
}
