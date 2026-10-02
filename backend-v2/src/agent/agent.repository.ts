import { Injectable } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  agents,
  applicationAgents,
  agentHeartbeats,
  type AgentHeartbeat,
  type Agent,
  type ApplicationAgent,
} from '../database/schema.js';

@Injectable()
export class AgentRepository {
  constructor(private readonly database: DatabaseService) {}

  create(agent: Agent): Agent {
    this.database.db.insert(agents).values(agent).run();
    return agent;
  }

  find(id: string): Agent | undefined {
    return this.database.db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .get();
  }

  list(): Agent[] {
    return this.database.db
      .select()
      .from(agents)
      .orderBy(asc(agents.createdAt))
      .all();
  }

  authenticate(tokenHash: string): Agent | undefined {
    return this.database.db
      .update(agents)
      .set({
        status: 'online',
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(agents.tokenHash, tokenHash), ne(agents.status, 'revoked')))
      .returning()
      .get();
  }

  update(id: string, patch: Partial<Agent>): Agent {
    return this.database.db
      .update(agents)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(agents.id, id))
      .returning()
      .get()!;
  }

  isAssigned(agentId: string, applicationId: string): boolean {
    return !!this.database.db
      .select()
      .from(applicationAgents)
      .where(
        and(
          eq(applicationAgents.agentId, agentId),
          eq(applicationAgents.applicationId, applicationId),
        ),
      )
      .get();
  }

  heartbeat(agentId: string): AgentHeartbeat | undefined {
    return this.database.db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentId, agentId))
      .get();
  }

  saveHeartbeat(value: AgentHeartbeat): void {
    this.database.db.transaction(() => {
      this.database.db
        .insert(agentHeartbeats)
        .values(value)
        .onConflictDoUpdate({ target: agentHeartbeats.agentId, set: value })
        .run();
      this.update(value.agentId, {
        status: 'online',
        lastSeenAt: value.receivedAt,
      });
    });
  }

  assign(link: ApplicationAgent): void {
    this.database.db
      .insert(applicationAgents)
      .values(link)
      .onConflictDoNothing()
      .run();
  }
}
