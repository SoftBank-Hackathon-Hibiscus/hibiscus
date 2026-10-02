import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  DeploymentArtifact,
  DeploymentAuditLog,
  Deployment,
  StageExecution,
} from '../database/schema.js';
import { DeploymentPaths } from './types/deployment.type.js';
import type {
  DeploymentArtifactIdentity,
  DeploymentAuditPayload,
} from './types/deployment.type.js';

// 계약 JSON은 수정하지 않고 원본 문자열과 해시를 저장합니다.
@Injectable()
export class DeploymentArtifactService {
  restore(paths: DeploymentPaths, artifacts: DeploymentArtifact[]): void {
    for (const artifact of artifacts) {
      if (artifact.validationError || artifact.name === 'audit_log') continue;
      if (this.hash(artifact.content) !== artifact.contentHash)
        throw new Error('Stored artifact content hash mismatch');
      const destination = resolve(paths.root, artifact.relativePath);
      const inside = relative(paths.root, destination);
      if (inside.startsWith('..') || isAbsolute(inside))
        throw new Error('Artifact path is outside the execution directory');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, artifact.content, 'utf8');
    }
  }

  capture(
    paths: DeploymentPaths,
    execution: StageExecution,
    deployment: Deployment,
  ) {
    const artifacts: DeploymentArtifact[] = [];
    const auditLogs: DeploymentAuditLog[] = [];
    const timestamp = new Date().toISOString();
    const add = (
      filePath: string,
      name: string,
      relativePath = paths.relative(filePath),
    ) => {
      const content = readFileSync(filePath, 'utf8');
      const schema = this.schemaFor(relativePath);
      let validationError: string | null = null;
      if (schema) {
        try {
          const payload = JSON.parse(content) as DeploymentArtifactIdentity;
          if (
            payload.run_id !== deployment.id ||
            (payload.digest !== undefined &&
              payload.digest !== deployment.imageDigest) ||
            (payload.source_revision !== undefined &&
              payload.source_revision !== deployment.sourceRevision)
          )
            validationError = `${name} does not match the current deployment`;
        } catch {
          validationError = `Invalid JSON format for ${name}`;
        }
      }
      artifacts.push({
        id: randomUUID(),
        deploymentId: execution.deploymentId,
        stageExecutionId: execution.id,
        name,
        relativePath,
        mediaType: filePath.endsWith('.json')
          ? 'application/json'
          : 'text/plain',
        content,
        contentHash: this.hash(content),
        schemaName: schema ?? null,
        validationError,
        createdAt: timestamp,
      });
    };
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) walk(filePath);
        else if (entry.isFile())
          add(filePath, entry.name.replace(/\.(json|md|txt)$/, ''));
      }
    };
    walk(paths[execution.stage]);
    let error: string | undefined;
    if (existsSync(paths.decisionsLog)) {
      add(paths.decisionsLog, 'audit_log', `logs/${execution.stage}.jsonl`);
      for (const line of readFileSync(paths.decisionsLog, 'utf8')
        .split(/\r?\n/)
        .filter((value) => value.trim())) {
        try {
          const payload = JSON.parse(line) as DeploymentAuditPayload;
          const kind = payload.kind;
          if (
            payload.run_id !== deployment.id ||
            payload.digest !== deployment.imageDigest ||
            (payload.source_revision !== undefined &&
              payload.source_revision !== deployment.sourceRevision)
          )
            throw new Error('Audit log does not match the current deployment');
          auditLogs.push({
            id: randomUUID(),
            deploymentId: execution.deploymentId,
            stageExecutionId: execution.id,
            kind,
            payload,
            createdAt: timestamp,
          });
        } catch (issue) {
          error ??=
            issue instanceof SyntaxError
              ? 'Invalid audit log JSON format'
              : issue instanceof Error
                ? issue.message
                : 'Audit log validation failed';
        }
      }
      if (error)
        artifacts.find(
          (artifact) => artifact.name === 'audit_log',
        )!.validationError = error;
    }
    error ??=
      artifacts.find((artifact) => artifact.validationError)?.validationError ??
      undefined;
    return { artifacts, auditLogs, error };
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private schemaFor(path: string): string | undefined {
    const schemas: Record<string, string> = {
      'test/test_result.json': 'policy/contracts/TestResult.schema.json',
      'policy/test_result.json': 'policy/contracts/TestResult.schema.json',
      'policy/plan.json': 'contracts/Plan.schema.json',
      'policy/pii.json': 'policy/contracts/PiiReport.schema.json',
      'sign/approval.json': 'signer/contracts/Approval.schema.json',
      'sign/sign_result.json': 'contracts/SignResult.schema.json',
    };
    return schemas[path];
  }
}
