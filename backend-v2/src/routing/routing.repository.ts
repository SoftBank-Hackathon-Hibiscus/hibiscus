import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import {
  applicationRoutes,
  routingChanges,
  routingTargetHealth,
  routingTargets,
  type ApplicationRoute,
  type RoutingTarget,
  type RoutingTargetHealth,
} from '../database/schema.js';
import type { RouteSnapshot, RoutingTargetView } from './types/routing.type.js';

@Injectable()
export class RoutingRepository {
  constructor(private readonly database: DatabaseService) {}

  createTarget(target: RoutingTarget): RoutingTarget {
    this.database.db.insert(routingTargets).values(target).run();
    return target;
  }

  findTarget(id: string): RoutingTarget | undefined {
    return this.database.db
      .select()
      .from(routingTargets)
      .where(eq(routingTargets.id, id))
      .get();
  }

  findHealth(targetId: string): RoutingTargetHealth | undefined {
    return this.database.db
      .select()
      .from(routingTargetHealth)
      .where(eq(routingTargetHealth.targetId, targetId))
      .get();
  }

  listEnabledTargets(): RoutingTarget[] {
    return this.database.db
      .select()
      .from(routingTargets)
      .where(eq(routingTargets.enabled, true))
      .orderBy(asc(routingTargets.createdAt))
      .all();
  }

  listAgentForwards(agentId: string): RoutingTarget[] {
    return this.database.db
      .select()
      .from(routingTargets)
      .where(
        and(
          eq(routingTargets.agentId, agentId),
          eq(routingTargets.kind, 'onprem'),
          eq(routingTargets.enabled, true),
        ),
      )
      .orderBy(asc(routingTargets.createdAt))
      .all();
  }

  allocateGatewayPort(minimum: number, maximum: number): number | undefined {
    const used = new Set(
      this.database.db
        .select({ port: routingTargets.gatewayPort })
        .from(routingTargets)
        .all()
        .flatMap(({ port }) => (port === null ? [] : [port])),
    );
    for (let port = minimum; port <= maximum; port += 1) {
      if (!used.has(port)) return port;
    }
    return undefined;
  }

  findEquivalentTarget(
    applicationId: string,
    deploymentId: string,
    kind: RoutingTarget['kind'],
    agentId: string | null,
  ): RoutingTarget | undefined {
    return this.database.db
      .select()
      .from(routingTargets)
      .where(
        and(
          eq(routingTargets.applicationId, applicationId),
          eq(routingTargets.deploymentId, deploymentId),
          eq(routingTargets.kind, kind),
          agentId === null
            ? isNull(routingTargets.agentId)
            : eq(routingTargets.agentId, agentId),
        ),
      )
      .get();
  }

  listTargets(applicationId: string): RoutingTargetView[] {
    return this.database.db
      .select({ target: routingTargets, health: routingTargetHealth })
      .from(routingTargets)
      .leftJoin(
        routingTargetHealth,
        eq(routingTargetHealth.targetId, routingTargets.id),
      )
      .where(eq(routingTargets.applicationId, applicationId))
      .orderBy(asc(routingTargets.createdAt))
      .all();
  }

  route(applicationId: string): RouteSnapshot | undefined {
    const row = this.database.db
      .select({
        route: applicationRoutes,
        target: routingTargets,
        health: routingTargetHealth,
      })
      .from(applicationRoutes)
      .innerJoin(
        routingTargets,
        eq(applicationRoutes.targetId, routingTargets.id),
      )
      .leftJoin(
        routingTargetHealth,
        eq(routingTargetHealth.targetId, routingTargets.id),
      )
      .where(eq(applicationRoutes.applicationId, applicationId))
      .get();
    if (!row) return undefined;
    return {
      applicationId,
      target: row.target,
      revision: row.route.revision,
      health: row.health,
    };
  }

  changeRoute(
    applicationId: string,
    targetId: string,
    expectedRevision: number,
    changedBy: string,
    reason: string | null,
  ): RouteSnapshot | undefined {
    return this.database.db.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(applicationRoutes)
          .where(eq(applicationRoutes.applicationId, applicationId))
          .get();
        if ((current?.revision ?? 0) !== expectedRevision) return undefined;

        const now = new Date().toISOString();
        const revision = expectedRevision + 1;
        const route: ApplicationRoute = {
          applicationId,
          targetId,
          revision,
          changedBy,
          reason,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        tx.insert(applicationRoutes)
          .values(route)
          .onConflictDoUpdate({
            target: applicationRoutes.applicationId,
            set: {
              targetId,
              revision,
              changedBy,
              reason,
              updatedAt: now,
            },
          })
          .run();
        tx.insert(routingChanges)
          .values({
            id: randomUUID(),
            applicationId,
            previousTargetId: current?.targetId ?? null,
            targetId,
            previousRevision: expectedRevision,
            revision,
            changedBy,
            reason,
            createdAt: now,
          })
          .run();
        const target = tx
          .select()
          .from(routingTargets)
          .where(eq(routingTargets.id, targetId))
          .get()!;
        const health = tx
          .select()
          .from(routingTargetHealth)
          .where(eq(routingTargetHealth.targetId, targetId))
          .get();
        return {
          applicationId,
          target,
          revision,
          health: health ?? null,
        };
      },
      { behavior: 'immediate' },
    );
  }

  saveHealth(value: RoutingTargetHealth): RoutingTargetHealth {
    return this.database.db.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(routingTargetHealth)
          .where(eq(routingTargetHealth.targetId, value.targetId))
          .get();
        if (current && current.observedAt >= value.observedAt) return current;
        tx.insert(routingTargetHealth)
          .values(value)
          .onConflictDoUpdate({
            target: routingTargetHealth.targetId,
            set: value,
          })
          .run();
        return value;
      },
      { behavior: 'immediate' },
    );
  }
}
