import { Injectable } from '@nestjs/common';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeploymentPaths } from './types/deployment.type.js';

export const APPLICATION_POLICY_PATH = '.hibiscus/policy.yaml';
const APPLICATION_POLICY_DIRECTORY = '.hibiscus';
const MAX_APPLICATION_POLICY_BYTES = 256 * 1024;
const POLICY_INPUT_PATH = 'policy-input/policy.yaml';

@Injectable()
export class ApplicationPolicyInputService {
  capture(sourceRoot: string, paths: DeploymentPaths): string | null {
    const policyDirectory = join(sourceRoot, APPLICATION_POLICY_DIRECTORY);
    if (!existsSync(policyDirectory)) return null;
    const directoryStat = lstatSync(policyDirectory);
    if (directoryStat.isSymbolicLink()) {
      throw new Error(
        'Application policy directory must not be a symbolic link',
      );
    }
    if (!directoryStat.isDirectory()) return null;

    const source = join(policyDirectory, 'policy.yaml');
    if (!existsSync(source)) return null;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Application policy must be a regular file');
    }
    if (stat.size > MAX_APPLICATION_POLICY_BYTES) {
      throw new Error('Application policy exceeds the 256 KiB size limit');
    }

    const policy = readFileSync(source);
    if (policy.byteLength > MAX_APPLICATION_POLICY_BYTES) {
      throw new Error('Application policy exceeds the 256 KiB size limit');
    }
    const destination = this.path(paths);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, policy, { flag: 'wx' });
    return paths.relative(destination);
  }

  path(paths: DeploymentPaths): string {
    return join(paths.test, POLICY_INPUT_PATH);
  }
}
