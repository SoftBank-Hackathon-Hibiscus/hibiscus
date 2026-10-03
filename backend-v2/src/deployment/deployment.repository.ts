import { redactDeploymentOutput } from '../infrastructure/command-diagnostics.js';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, or, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  deployments,
  deploymentEnvironmentVariables,
  policyResults,
  stageExecutions,
  deploymentArtifacts,
  deploymentAuditLogs,
  applicationRoutes,
  routingTargets,
  type DeploymentArtifact,
  type DeploymentAuditLog,
  type Deployment,
  type PolicyResult,
  type StageExecution,
} from '../database/schema.js';

@Injectable()
export class DeploymentRepository {
  constructor(private readonly database: DatabaseService) {}

  create(
    values: Omit<Deployment, 'version'>,
    environment: {
      runtime: Record<string, string>;
      test: Record<string, string>;
    },
  ): Deployment {
    return this.database.db.transaction((tx) => {
      const latest = tx
        .select({ version: deployments.version })
        .from(deployments)
        .where(eq(deployments.applicationId, values.applicationId))
        .orderBy(desc(deployments.version))
        .limit(1)
        .get();
      const deployment = { ...values, version: (latest?.version ?? 0) + 1 };
      tx.insert(deployments).values(deployment).run();
      const snapshot = (['runtime', 'test'] as const).flatMap((kind) =>
        Object.entries(environment[kind]).map(([name, value]) => ({
          deploymentId: deployment.id,
          kind,
          name,
          value,
        })),
      );
      if (snapshot.length)
        tx.insert(deploymentEnvironmentVariables).values(snapshot).run();
      return deployment;
    });
  }

  environment(
    deploymentId: string,
    kind: 'runtime' | 'test',
  ): Record<string, string> {
    return Object.fromEntries(
      this.database.db
        .select({
          name: deploymentEnvironmentVariables.name,
          value: deploymentEnvironmentVariables.value,
        })
        .from(deploymentEnvironmentVariables)
        .where(
          and(
            eq(deploymentEnvironmentVariables.deploymentId, deploymentId),
            eq(deploymentEnvironmentVariables.kind, kind),
          ),
        )
        .orderBy(asc(deploymentEnvironmentVariables.name))
        .all()
        .map(({ name, value }) => [name, value]),
    );
  }

  find(id: string): Deployment | undefined {
    return this.database.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .get();
  }

  findActive(applicationId: string): Deployment | undefined {
    return this.database.db
      .select({ deployment: deployments })
      .from(applicationRoutes)
      .innerJoin(
        routingTargets,
        eq(applicationRoutes.targetId, routingTargets.id),
      )
      .innerJoin(deployments, eq(routingTargets.deploymentId, deployments.id))
      .where(eq(applicationRoutes.applicationId, applicationId))
      .get()?.deployment;
  }

  findPolicyResult(deploymentId: string): PolicyResult | undefined {
    return this.database.db
      .select()
      .from(policyResults)
      .where(eq(policyResults.deploymentId, deploymentId))
      .get();
  }

  hasSuccessfulSignResult(deploymentId: string): boolean {
    return Boolean(
      this.database.db
        .select({ id: deploymentArtifacts.id })
        .from(deploymentArtifacts)
        .innerJoin(
          stageExecutions,
          eq(deploymentArtifacts.stageExecutionId, stageExecutions.id),
        )
        .where(
          and(
            eq(deploymentArtifacts.deploymentId, deploymentId),
            eq(deploymentArtifacts.name, 'sign_result'),
            eq(stageExecutions.stage, 'sign'),
            eq(stageExecutions.status, 'succeeded'),
          ),
        )
        .limit(1)
        .get(),
    );
  }

  list(applicationId: string): Deployment[] {
    return this.database.db
      .select()
      .from(deployments)
      .where(eq(deployments.applicationId, applicationId))
      .orderBy(desc(deployments.version))
      .all();
  }

  getView(id: string) {
    const deployment = this.find(id);
    if (!deployment) return undefined;
    const stages = this.database.db
      .select()
      .from(stageExecutions)
      .where(eq(stageExecutions.deploymentId, id))
      .orderBy(asc(stageExecutions.sequence), asc(stageExecutions.attempt))
      .all();
    const policyResult = this.findPolicyResult(id);
    const artifacts = this.listArtifacts(id);
    const auditLogs = this.database.db
      .select()
      .from(deploymentAuditLogs)
      .where(eq(deploymentAuditLogs.deploymentId, id))
      .orderBy(
        asc(deploymentAuditLogs.createdAt),
        asc(sql`${deploymentAuditLogs}.rowid`),
      )
      .all();
    return {
      deployment,
      stages,
      policyResult: policyResult ?? null,
      artifacts,
      auditLogs,
    };
  }

  listArtifacts(
    deploymentId: string,
    successfulOnly = false,
  ): DeploymentArtifact[] {
    return this.database.db
      .select({ artifact: deploymentArtifacts })
      .from(deploymentArtifacts)
      .innerJoin(
        stageExecutions,
        eq(deploymentArtifacts.stageExecutionId, stageExecutions.id),
      )
      .where(
        successfulOnly
          ? and(
              eq(deploymentArtifacts.deploymentId, deploymentId),
              eq(stageExecutions.status, 'succeeded'),
            )
          : eq(deploymentArtifacts.deploymentId, deploymentId),
      )
      .orderBy(
        asc(stageExecutions.sequence),
        asc(stageExecutions.attempt),
        asc(deploymentArtifacts.relativePath),
      )
      .all()
      .map((row) => row.artifact);
  }

  checkpoint(
    artifacts: DeploymentArtifact[],
    logs: DeploymentAuditLog[],
    commit: (artifactIds: Record<string, string>) => void,
  ): void {
    this.database.db.transaction(() => {
      for (const artifact of artifacts)
        this.database.db.insert(deploymentArtifacts).values(artifact).run();
      for (const log of logs)
        this.database.db.insert(deploymentAuditLogs).values(log).run();
      const artifactIds = Object.fromEntries(
        artifacts.map((artifact) => [artifact.name, artifact.id]),
      );
      commit(artifactIds);
    });
  }

  findQueued(): Deployment | undefined {
    return this.database.db
      .select()
      .from(deployments)
      .where(eq(deployments.status, 'queued'))
      .orderBy(asc(deployments.createdAt))
      .limit(1)
      .get();
  }

  claim(id: string): boolean {
    return (
      this.database.db
        .update(deployments)
        .set({ status: 'running', updatedAt: new Date().toISOString() })
        .where(and(eq(deployments.id, id), eq(deployments.status, 'queued')))
        .run().changes === 1
    );
  }

  requeueInterrupted(): void {
    this.database.db
      .update(deployments)
      .set({ status: 'queued', updatedAt: new Date().toISOString() })
      .where(eq(deployments.status, 'running'))
      .run();
  }

  update(id: string, patch: Partial<typeof deployments.$inferInsert>): void {
    this.database.db
      .update(deployments)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(and(eq(deployments.id, id), ne(deployments.status, 'cancelled')))
      .run();
  }

  cancel(id: string): boolean {
    return (
      this.database.db
        .update(deployments)
        .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(deployments.id, id),
            inArray(deployments.status, [
              'queued',
              'awaiting_approval',
              'running',
            ]),
            or(
              isNull(deployments.currentStage),
              ne(deployments.currentStage, 'deploy'),
            ),
          ),
        )
        .run().changes === 1
    );
  }

  approve(id: string, approver: string): boolean {
    return (
      this.database.db
        .update(deployments)
        .set({
          approver,
          status: 'queued',
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(deployments.id, id),
            eq(deployments.status, 'awaiting_approval'),
          ),
        )
        .run().changes === 1
    );
  }

  nextAttempt(deploymentId: string, stage: StageExecution['stage']): number {
    const latest = this.database.db
      .select({ attempt: stageExecutions.attempt })
      .from(stageExecutions)
      .where(
        and(
          eq(stageExecutions.deploymentId, deploymentId),
          eq(stageExecutions.stage, stage),
        ),
      )
      .orderBy(desc(stageExecutions.attempt))
      .limit(1)
      .get();
    return (latest?.attempt ?? 0) + 1;
  }

  createStage(stage: StageExecution): void {
    this.database.db.insert(stageExecutions).values(stage).run();
  }

  updateStage(
    id: string,
    patch: Partial<typeof stageExecutions.$inferInsert>,
  ): void {
    const stage = this.database.db
      .select()
      .from(stageExecutions)
      .where(eq(stageExecutions.id, id))
      .get();
    const secrets = stage
      ? [
          ...Object.values(this.environment(stage.deploymentId, 'runtime')),
          ...Object.values(this.environment(stage.deploymentId, 'test')),
        ]
      : [];
    this.database.db
      .update(stageExecutions)
      .set({
        ...patch,
        ...(patch.summary !== undefined
          ? { summary: redactDeploymentOutput(patch.summary, secrets) }
          : {}),
        ...(patch.error
          ? { error: redactDeploymentOutput(patch.error, secrets) }
          : {}),
      })
      .where(eq(stageExecutions.id, id))
      .run();
  }

  savePolicyResult(result: PolicyResult): void {
    this.database.db
      .insert(policyResults)
      .values(result)
      .onConflictDoUpdate({
        target: policyResults.deploymentId,
        set: {
          decision: result.decision,
          planHash: result.planHash,
          targets: result.targets,
          failoverAllowed: result.failoverAllowed,
          requires: result.requires,
          policyPath: result.policyPath,
          policyHash: result.policyHash,
          skipped: result.skipped,
          planPath: result.planPath,
          piiPath: result.piiPath,
          planArtifactId: result.planArtifactId,
          piiArtifactId: result.piiArtifactId,
          updatedAt: result.updatedAt,
        },
      })
      .run();
  }
}
