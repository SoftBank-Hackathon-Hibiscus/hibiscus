import type {
  Application,
  Deployment,
  PolicyResult,
} from '../../database/schema.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export class DeploymentPaths {
  readonly root: string;
  readonly test: string;
  readonly policy: string;
  readonly sign: string;
  readonly deploy: string;
  readonly decisionsLog: string;

  constructor(
    readonly workDir: string,
    readonly deploymentId: string,
  ) {
    mkdirSync(workDir, { recursive: true });
    this.root = mkdtempSync(join(workDir, `${deploymentId}-`));
    this.test = join(this.root, 'test');
    this.policy = join(this.root, 'policy');
    this.sign = join(this.root, 'sign');
    this.deploy = join(this.root, 'deploy');
    this.decisionsLog = join(this.root, 'decisions.jsonl');
  }

  ensure(): void {
    for (const path of [this.test, this.policy, this.sign, this.deploy]) {
      mkdirSync(path, { recursive: true });
    }
  }

  relative(absolutePath: string): string {
    return relative(this.root, resolve(absolutePath)).split('\\').join('/');
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export interface StageContext {
  diagnosticSecrets?: string[];
  application: Application;
  deployment: Deployment;
  paths: DeploymentPaths;
  approval?: { approver: string };
}

export interface StageOutcome {
  status: 'succeeded' | 'failed' | 'skipped';
  exitCode?: number | null;
  artifacts: Record<string, string>;
  summary?: unknown;
  error?: string;
  deploymentPatch?: Partial<Deployment>;
  policyResult?: Omit<
    PolicyResult,
    | 'deploymentId'
    | 'createdAt'
    | 'updatedAt'
    | 'planArtifactId'
    | 'piiArtifactId'
  >;
}

export interface StageRunner {
  readonly name: 'test' | 'policy' | 'sign' | 'deploy';
  run(context: StageContext): Promise<StageOutcome>;
}

export function tail(text: string, lines = 8): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

export interface DeploymentPlan {
  run_id: string;
  app: string;
  digest: string;
  source_revision?: string;
  decision: NonNullable<Deployment['decision']>;
  targets: string[];
  failover_allowed: boolean;
  rules: {
    id: string;
    result: 'matched' | 'not_matched' | 'matched_after_block';
    reason?: string;
  }[];
  requires?: { id: string; rule_id: string; allowed_targets: string[] }[];
  plan_hash: string;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return item;
  });
}

export interface DeploymentSignResult {
  run_id: string;
  digest: string;
  source_revision?: string;
  plan_hash: string;
  targets: string[];
  failover_allowed: boolean;
  requester: string;
  approver: string;
  signature_ref: string;
  signed_at: string;
}

export interface DeploymentArtifactIdentity {
  run_id: string;
  digest?: string;
  source_revision?: string;
}

export interface DeploymentAuditPayload extends Record<string, unknown> {
  kind: 'deploy' | 'rollback' | 'sign';
  run_id: string;
  digest: string;
  source_revision?: string;
}
