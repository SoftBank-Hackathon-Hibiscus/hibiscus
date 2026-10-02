import { join } from 'node:path';
import {
  CommandRunner,
  parseLastJsonLine,
} from '../../infrastructure/command-runner.js';
import type { CloudRunPort } from '../types/deploy-result.type.js';
import { tail } from '../types/deployment.type.js';

export interface CloudRunOptions {
  scriptsDir: string;
  projectId: string;
  region: string;
  service: string;
  tag: string;
  /** 앱 컨테이너가 듣는 포트 (Application.containerPort) */
  containerPort: number;
  timeoutMs: number;
}

/**
 * deploy/cloudrun/*.sh 를 실행한다. 스크립트는 gcloud 진행 메시지를 stderr 로,
 * 결과를 stdout 마지막 줄 JSON 으로 낸다.
 * 스크립트용 값은 `env 이름=값 ... 스크립트` 로 넘긴다. backend 자신의 PORT 등 나머지 환경은 그대로 물려받는다.
 */
export class CloudRunClient implements CloudRunPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: CloudRunOptions,
  ) {}

  async candidate(imageRef: string, runId: string) {
    const out = await this.script<{ revision: string; candidate_url: string }>(
      'candidate.sh',
      [imageRef, '', runId],
    );
    if (!out.revision || !out.candidate_url)
      throw new Error('candidate.sh did not return revision and candidate_url');
    return { revision: out.revision, candidateUrl: out.candidate_url };
  }

  async activate() {
    const out = await this.script<{ previous: string; serving: string }>(
      'activate.sh',
      [],
    );
    return { previous: out.previous ?? '', serving: out.serving ?? '' };
  }

  async rollback(revision: string): Promise<void> {
    await this.script('rollback.sh', [revision]);
  }

  async discard(): Promise<void> {
    await this.script('discard.sh', []);
  }

  serviceUrl(candidateUrl: string): string {
    return candidateUrl.replace(`://${this.options.tag}---`, '://');
  }

  private async script<T>(name: string, args: string[]): Promise<Partial<T>> {
    const { scriptsDir, projectId, region, service, tag, containerPort } =
      this.options;
    const result = await this.runner.run({
      command: 'env',
      args: [
        `PROJECT_ID=${projectId}`,
        `REGION=${region}`,
        `SERVICE=${service}`,
        `TAG=${tag}`,
        `PORT=${containerPort}`,
        join(scriptsDir, name),
        ...args,
      ],
      cwd: scriptsDir,
      timeoutMs: this.options.timeoutMs,
    });
    if (result.timedOut) throw new Error(`${name} timed out`);
    if (result.code !== 0)
      throw new Error(
        `${name} failed (exit code ${result.code ?? 'unknown'}): ${tail(result.stderr, 3)}`,
      );
    const parsed = parseLastJsonLine(result.stdout);
    if (!parsed || typeof parsed !== 'object')
      throw new Error(`${name} did not print a JSON result`);
    return parsed as Partial<T>;
  }
}
