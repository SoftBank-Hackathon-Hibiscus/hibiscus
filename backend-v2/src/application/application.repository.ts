import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  agents,
  applicationAgents,
  applications,
  healthCheckConfigs,
  type Application,
  type HealthCheckConfig,
} from '../database/schema.js';

export interface ApplicationView {
  application: Application;
  healthCheck: HealthCheckConfig;
  agents: Array<{
    id: string;
    name: string;
    status: 'registered' | 'online' | 'offline' | 'revoked';
    lastSeenAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}

@Injectable()
export class ApplicationRepository {
  constructor(private readonly database: DatabaseService) {}

  create(
    application: Application,
    healthCheck: HealthCheckConfig,
  ): ApplicationView {
    this.database.db.transaction((tx) => {
      tx.insert(applications).values(application).run();
      tx.insert(healthCheckConfigs).values(healthCheck).run();
    });
    return { application, healthCheck, agents: [] };
  }

  find(id: string): Application | undefined {
    return this.database.db
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .get();
  }

  getView(id: string): ApplicationView | undefined {
    const application = this.find(id);
    if (!application) return undefined;
    const healthCheck = this.database.db
      .select()
      .from(healthCheckConfigs)
      .where(eq(healthCheckConfigs.applicationId, id))
      .get();
    if (!healthCheck) throw new Error('Health check configuration not found');
    const assignedAgents = this.database.db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        lastSeenAt: agents.lastSeenAt,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(applicationAgents)
      .innerJoin(agents, eq(applicationAgents.agentId, agents.id))
      .where(eq(applicationAgents.applicationId, id))
      .orderBy(asc(agents.createdAt))
      .all();
    return { application, healthCheck, agents: assignedAgents };
  }

  list(): ApplicationView[] {
    return this.database.db
      .select({ id: applications.id })
      .from(applications)
      .orderBy(asc(applications.createdAt))
      .all()
      .map(({ id }) => this.getView(id)!);
  }

  updateHealthCheck(
    applicationId: string,
    patch: Partial<typeof healthCheckConfigs.$inferInsert>,
  ): HealthCheckConfig | undefined {
    this.database.db
      .update(healthCheckConfigs)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(healthCheckConfigs.applicationId, applicationId))
      .run();
    return this.database.db
      .select()
      .from(healthCheckConfigs)
      .where(eq(healthCheckConfigs.applicationId, applicationId))
      .get();
  }
}
