import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationRepository } from '../../application/application.repository.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  applications,
  applicationRoutes,
  routingTargets,
} from '../../database/schema.js';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import { DeploymentRepository } from '../deployment.repository.js';
import { DeploymentService } from '../deployment.service.js';
import { DeploymentWorker } from '../deployment.worker.js';
import { DeploymentArtifactService } from '../deployment-artifact.service.js';
import { TestStage } from '../stages/test.stage.js';
import { PolicyStage } from '../stages/policy.stage.js';
import { SignStage } from '../stages/sign.stage.js';
import { DeployStage } from '../stages/deploy.stage.js';
import {
  DeploymentPaths,
  type StageOutcome,
} from '../types/deployment.type.js';

describe('deployment controls with persisted state', () => {
  let directory: string;
  let database: DatabaseService;
  let repository: DeploymentRepository;
  let service: DeploymentService;
  let apps: ApplicationRepository;
  let config: ConfigService<BackendConfig, true>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deployment-controls-'));
    config = new ConfigService({
      backend: { databaseFile: join(directory, 'test.db'), stageMode: 'cli' },
    }) as ConfigService<BackendConfig, true>;
    database = new DatabaseService(config);
    database.onModuleInit();
    const now = new Date().toISOString();
    database.db
      .insert(applications)
      .values({
        id: 'app',
        name: 'App',
        slug: 'app',
        sourcePath: '.',
        imageRepo: 'registry/app',
        testTemplate: 'allow',
        requiresApproval: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    repository = new DeploymentRepository(database);
    apps = new ApplicationRepository(database);
    service = new DeploymentService(repository, apps, config);
  });
  afterEach(() => {
    database.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = () =>
    service.create('app', { source_revision: 'a'.repeat(40) }, 'requester');
  it.each(['queued', 'awaiting_approval', 'running'] as const)(
    'cancels %s and prevents stale completion',
    (status) => {
      const deployment = create();
      repository.update(deployment.id, { status, currentStage: 'sign' });
      expect(service.cancel(deployment.id).status).toBe('cancelled');
      expect(service.cancel(deployment.id).status).toBe('cancelled');
      expect(repository.claim(deployment.id)).toBe(false);
      expect(repository.approve(deployment.id, 'approver')).toBe(false);
      repository.requeueInterrupted();
      repository.update(deployment.id, { status: 'succeeded' });
      expect(repository.find(deployment.id)?.status).toBe('cancelled');
    },
  );
  it.each(['failed', 'succeeded', 'blocked'] as const)(
    'rejects cancellation of %s',
    (status) => {
      const deployment = create();
      repository.update(deployment.id, { status });
      expect(() => service.cancel(deployment.id)).toThrow(
        'cannot be cancelled',
      );
    },
  );
  it('rejects cancellation after deploy starts', () => {
    const deployment = create();
    repository.update(deployment.id, {
      status: 'running',
      currentStage: 'deploy',
    });
    expect(() => service.cancel(deployment.id)).toThrow('cannot be cancelled');
    repository.requeueInterrupted();
    expect(() => service.cancel(deployment.id)).toThrow('cannot be cancelled');
    expect(() => service.cancel('missing')).toThrow('Deployment not found');
  });
  it.each(['succeeded', 'failed'] as const)(
    'stops after cancellation during a %s test',
    async (status) => {
      const deployment = create();
      repository.claim(deployment.id);
      let complete!: (outcome: StageOutcome) => void;
      let started!: () => void;
      const testStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const run = vi.fn(() => {
        started();
        return new Promise<StageOutcome>((resolve) => {
          complete = resolve;
        });
      });
      const next = vi.fn();
      const worker = new DeploymentWorker(
        repository,
        apps,
        config,
        {
          capture: () => ({ artifacts: [], auditLogs: [] }),
        } as unknown as DeploymentArtifactService,
        { name: 'test', run } as unknown as TestStage,
        { name: 'policy', run: next } as unknown as PolicyStage,
        { name: 'sign', run: next } as unknown as SignStage,
        { name: 'deploy', run: next } as unknown as DeployStage,
      );
      const paths = new DeploymentPaths(directory, deployment.id);
      paths.ensure();
      const executing = worker['executePipeline'](deployment.id, paths);
      await testStarted;
      service.cancel(deployment.id);
      complete({
        status,
        artifacts: {},
        error: status === 'failed' ? 'test failed' : undefined,
      });
      await executing;
      expect(next).not.toHaveBeenCalled();
      expect(repository.find(deployment.id)?.status).toBe('cancelled');
      expect(repository.getView(deployment.id)?.stages[0]?.status).toBe(status);
    },
  );
  function history() {
    const older = service.create(
      'app',
      { source_revision: 'b'.repeat(40) },
      'old-user',
      'manual',
      { runtime: { MODE: 'old' }, test: { TEST_MODE: 'old-test' } },
    );
    repository.update(older.id, {
      status: 'succeeded',
      deploymentPerformed: true,
    });
    const active = create();
    repository.update(active.id, {
      status: 'succeeded',
      deploymentPerformed: true,
    });
    const now = new Date().toISOString();
    database.db
      .insert(routingTargets)
      .values({
        id: 'target',
        applicationId: 'app',
        deploymentId: active.id,
        kind: 'cloud_run',
        enabled: true,
        url: 'https://app.example',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database.db
      .insert(applicationRoutes)
      .values({
        applicationId: 'app',
        targetId: 'target',
        revision: 1,
        changedBy: 'requester',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { older, active };
  }
  it('restores previous source and both environment snapshots without changing route before verification', () => {
    const { older, active } = history();
    const rollback = service.rollback(older.id, 'new-user');
    expect(rollback).toMatchObject({
      sourceRevision: older.sourceRevision,
      trigger: 'rollback',
      status: 'queued',
      version: 3,
      requester: 'new-user',
      approver: null,
      sourceRevisionVerified: false,
      deploymentPerformed: false,
      digestSource: 'placeholder',
    });
    expect(repository.environment(rollback.id, 'runtime')).toEqual({
      MODE: 'old',
    });
    expect(repository.environment(rollback.id, 'test')).toEqual({
      TEST_MODE: 'old-test',
    });
    expect(repository.findActive('app')?.id).toBe(active.id);
    expect(() => service.rollback(older.id, 'new-user')).toThrow(
      'pending deployments',
    );
  });
  it('rejects active, failed, simulated and missing rollback targets', () => {
    const { older, active } = history();
    expect(() => service.rollback(active.id, 'user')).toThrow('older than');
    repository.update(older.id, { deploymentPerformed: false });
    expect(() => service.rollback(older.id, 'user')).toThrow(
      'successfully deployed',
    );
    repository.update(older.id, {
      status: 'failed',
      deploymentPerformed: true,
    });
    expect(() => service.rollback(older.id, 'user')).toThrow(
      'successfully deployed',
    );
    expect(() => service.rollback('missing', 'user')).toThrow(
      'Deployment not found',
    );
  });
});
