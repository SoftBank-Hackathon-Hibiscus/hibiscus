import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApplicationPolicyInputService } from '../application-policy-input.service.js';
import { DeploymentPaths } from '../types/deployment.type.js';

describe('ApplicationPolicyInputService', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function setup() {
    const source = mkdtempSync(join(tmpdir(), 'hibiscus-policy-source-'));
    const work = mkdtempSync(join(tmpdir(), 'hibiscus-policy-work-'));
    directories.push(source, work);
    const paths = new DeploymentPaths(work, 'deployment-1');
    paths.ensure();
    return { source, paths, service: new ApplicationPolicyInputService() };
  }

  it('copies the application policy into the test-stage handoff directory', () => {
    const { source, paths, service } = setup();
    mkdirSync(join(source, '.hibiscus'));
    writeFileSync(
      join(source, '.hibiscus/policy.yaml'),
      'version: 1\n',
      'utf8',
    );

    expect(service.capture(source, paths)).toBe(
      'test/policy-input/policy.yaml',
    );
    expect(readFileSync(service.path(paths), 'utf8')).toBe('version: 1\n');
  });

  it('returns null when the application has no policy file', () => {
    const { source, paths, service } = setup();

    expect(service.capture(source, paths)).toBeNull();
  });

  it('rejects a symbolic-link policy input', () => {
    const { source, paths, service } = setup();
    mkdirSync(join(source, '.hibiscus'));
    writeFileSync(join(source, 'outside.yaml'), 'version: 1\n', 'utf8');
    symlinkSync(
      join(source, 'outside.yaml'),
      join(source, '.hibiscus/policy.yaml'),
    );

    expect(() => service.capture(source, paths)).toThrow(
      'Application policy must be a regular file',
    );
  });

  it('rejects a symbolic-link application policy directory', () => {
    const { source, paths, service } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'hibiscus-policy-outside-'));
    directories.push(outside);
    writeFileSync(join(outside, 'policy.yaml'), 'version: 1\n', 'utf8');
    symlinkSync(outside, join(source, '.hibiscus'), 'dir');

    expect(() => service.capture(source, paths)).toThrow(
      'Application policy directory must not be a symbolic link',
    );
  });

  it('rejects an application policy larger than 256 KiB', () => {
    const { source, paths, service } = setup();
    mkdirSync(join(source, '.hibiscus'));
    writeFileSync(
      join(source, '.hibiscus/policy.yaml'),
      Buffer.alloc(256 * 1024 + 1),
    );

    expect(() => service.capture(source, paths)).toThrow(
      'Application policy exceeds the 256 KiB size limit',
    );
  });

  it('accepts an application policy of exactly 256 KiB', () => {
    const { source, paths, service } = setup();
    mkdirSync(join(source, '.hibiscus'));
    const policy = Buffer.alloc(256 * 1024, '#');
    writeFileSync(join(source, '.hibiscus/policy.yaml'), policy);

    expect(service.capture(source, paths)).toBe(
      'test/policy-input/policy.yaml',
    );
    expect(readFileSync(service.path(paths))).toEqual(policy);
  });
});
