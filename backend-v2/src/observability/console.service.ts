import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ApplicationService } from '../application/application.service.js';
import { DeploymentService } from '../deployment/deployment.service.js';
import { RoutingRepository } from '../routing/routing.repository.js';
import { CommandRunner } from '../infrastructure/command-runner.js';
import type { DeployConfig } from '../config/configs/deploy.config.js';
import type { BackendConfig } from '../config/configs/backend.config.js';
import { RuntimeLogsService } from './runtime-logs.service.js';
import { LogRedactionService } from './log-redaction.service.js';
import type { LogsQueryDto } from './dto/console.dto.js';
import type { RuntimeLogEntry } from './types/console.type.js';
const deployArtifact = z.object({
  targets: z.array(
    z.object({
      target: z.string(),
      revision: z.string().optional(),
      phase: z.string(),
      result: z.string(),
    }),
  ),
});
const cloudEntries = z.array(
  z.object({
    insertId: z.string().optional(),
    timestamp: z.string(),
    severity: z.string().optional(),
    textPayload: z.string().optional(),
    jsonPayload: z.record(z.string(), z.unknown()).optional(),
    logName: z.string().optional(),
  }),
);
@Injectable()
export class ConsoleService {
  private readonly cache = new Map<
    string,
    { at: number; entries: RuntimeLogEntry[] }
  >();
  private readonly pending = new Map<string, Promise<RuntimeLogEntry[]>>();
  constructor(
    private readonly apps: ApplicationService,
    private readonly deployments: DeploymentService,
    private readonly routes: RoutingRepository,
    private readonly logs: RuntimeLogsService,
    private readonly redaction: LogRedactionService,
    private readonly runner: CommandRunner,
    private readonly config: ConfigService<DeployConfig & BackendConfig, true>,
  ) {}
  async readLogs(applicationId: string, query: LogsQueryDto) {
    const app = this.apps.get(applicationId);
    const deploymentId =
      query.deployment_id ??
      this.routes.route(applicationId)?.target.deploymentId;
    if (!deploymentId)
      return {
        entries: [],
        truncated: false,
        fetchedAt: new Date().toISOString(),
        source: query.target,
      };
    const view = this.deployments.get(deploymentId);
    if (view.deployment.applicationId !== applicationId)
      throw new NotFoundException('Deployment not found for application');
    if (query.target === 'onprem')
      return this.logs.read(applicationId, deploymentId, query);
    const result = view.artifacts
      .filter((a) => a.name === 'deploy_result' && !a.validationError)
      .at(-1);
    let revision: string | undefined;
    try {
      revision =
        result &&
        deployArtifact
          .parse(JSON.parse(result.content))
          .targets.find(
            (t) =>
              t.target === 'cloud_run' &&
              t.phase === 'candidate' &&
              t.result === 'ok',
          )?.revision;
    } catch {
      /* Unavailable mapping must never broaden the query. */
    }
    if (!revision)
      return {
        entries: [],
        truncated: false,
        fetchedAt: new Date().toISOString(),
        source: 'cloud_run',
        unavailable: '이 배포의 Cloud Run 로그 대상이 없습니다.',
      };
    const project = this.config.get('deploy.projectId', { infer: true });
    if (!project)
      throw new ServiceUnavailableException(
        'Cloud Run log project is not configured',
      );
    const service =
      this.config.get('deploy.cloudRunService', { infer: true }) ||
      app.application.slug;
    const key = `${applicationId}:${deploymentId}:${query.seconds}`;
    let entries = this.cache.get(key);
    if (!entries || Date.now() - entries.at > 5000) {
      const fetchLogs = async () => {
        const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name=${JSON.stringify(service)} AND resource.labels.revision_name=${JSON.stringify(revision)} AND (logName="projects/${project}/logs/run.googleapis.com%2Fstdout" OR logName="projects/${project}/logs/run.googleapis.com%2Fstderr") AND timestamp>=${JSON.stringify(new Date(Date.now() - query.seconds * 1000).toISOString())}`;
        const output = await this.runner
          .run({
            command: 'gcloud',
            args: [
              'logging',
              'read',
              filter,
              '--project',
              project,
              '--limit',
              '1000',
              '--order',
              'desc',
              '--format',
              'json',
            ],
            cwd: this.config.get('backend.repoRoot', { infer: true }),
            timeoutMs: 10000,
          })
          .catch(() => {
            throw new ServiceUnavailableException(
              'Cloud Run logs could not be read. Check Cloud Logging access.',
            );
          });
        if (output.code !== 0 || output.timedOut)
          throw new ServiceUnavailableException(
            'Cloud Run logs could not be read. Check Cloud Logging access.',
          );
        let payload: unknown;
        try {
          payload = JSON.parse(output.stdout);
        } catch {
          throw new ServiceUnavailableException(
            'Cloud Logging returned an invalid response',
          );
        }
        const parsed = cloudEntries.safeParse(payload);
        if (!parsed.success)
          throw new ServiceUnavailableException(
            'Cloud Logging returned an invalid response',
          );
        const secrets = this.logs.secrets(applicationId, deploymentId);
        return parsed.data.map((e, i) => ({
          id: e.insertId ?? `${e.timestamp}:${i}`,
          timestamp: e.timestamp,
          stream: e.logName?.endsWith('stderr')
            ? ('stderr' as const)
            : ('stdout' as const),
          level:
            e.severity === 'ERROR' ||
            e.severity === 'CRITICAL' ||
            e.severity === 'ALERT' ||
            e.severity === 'EMERGENCY'
              ? ('ERROR' as const)
              : e.severity === 'WARNING'
                ? ('WARN' as const)
                : ('INFO' as const),
          message: this.redaction.redact(
            e.textPayload ?? JSON.stringify(e.jsonPayload ?? {}),
            secrets,
          ),
        }));
      };
      const work = this.pending.get(key) ?? fetchLogs();
      this.pending.set(key, work);
      try {
        entries = { at: Date.now(), entries: await work };
        this.cache.set(key, entries);
        if (this.cache.size > 100)
          this.cache.delete(this.cache.keys().next().value!);
      } finally {
        this.pending.delete(key);
      }
    }
    const secrets = this.logs.secrets(applicationId, deploymentId);
    const filtered = entries.entries
      .map((e) => ({
        ...e,
        message: this.redaction.redact(e.message, secrets),
      }))
      .filter(
        (e) =>
          (query.level === 'all' || e.level === query.level) &&
          e.message.toLowerCase().includes(query.search.toLowerCase()),
      );
    return {
      entries: filtered.slice(0, query.limit).reverse(),
      truncated:
        filtered.length > query.limit || entries.entries.length >= 1000,
      fetchedAt: new Date(entries.at).toISOString(),
      source: 'cloud_run',
    };
  }
}
