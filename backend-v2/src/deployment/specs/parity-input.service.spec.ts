import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/configs/backend.config.js';
import { ParityInputService } from '../parity-input.service.js';

describe('ParityInputService', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not require baseline files in fixture mode', () => {
    expect(() =>
      service('fixture', '').assertRegistrationReady('demo'),
    ).not.toThrow();
  });

  it('accepts a configured registry parity slug', () => {
    const { inputsFile } = parityFiles('demo');
    expect(() =>
      service('registry', inputsFile).assertRegistrationReady('demo'),
    ).not.toThrow();
  });

  it('rejects registration when the registry parity slug is missing', () => {
    const { inputsFile } = parityFiles('configured');
    expect(() =>
      service('registry', inputsFile).assertRegistrationReady('missing'),
    ).toThrow('Registry parity inputs are not configured');
  });

  function parityFiles(slug: string) {
    const directory = mkdtempSync(join(tmpdir(), 'parity-inputs-'));
    directories.push(directory);
    const record = join(directory, 'record.jsonl');
    const noise = join(directory, 'noise.json');
    const inputsFile = join(directory, 'inputs.json');
    writeFileSync(record, '{}\n');
    writeFileSync(noise, '{}\n');
    writeFileSync(inputsFile, JSON.stringify({ [slug]: { record, noise } }));
    return { inputsFile };
  }

  function service(mode: 'fixture' | 'registry', inputsFile: string) {
    const config = {
      get: (key: string) =>
        ({
          'backend.parityTestMode': mode,
          'backend.parityInputsFile': inputsFile,
        })[key],
    } as ConfigService<BackendConfig, true>;
    return new ParityInputService(config);
  }
});
