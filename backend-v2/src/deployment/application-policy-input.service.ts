import { Injectable } from '@nestjs/common';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeploymentPaths } from './types/deployment.type.js';

export const APPLICATION_POLICY_PATH = '.hibiscus/policy.yaml';
const POLICY_INPUT_PATH = 'policy-input/policy.yaml';

@Injectable()
export class ApplicationPolicyInputService {
  capture(sourceRoot: string, paths: DeploymentPaths): string | null {
    const source = join(sourceRoot, APPLICATION_POLICY_PATH);
    if (!existsSync(source)) return null;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Application policy must be a regular file');
    }
    const destination = this.path(paths);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    return paths.relative(destination);
  }

  path(paths: DeploymentPaths): string {
    return join(paths.test, POLICY_INPUT_PATH);
  }
}
