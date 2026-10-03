import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParityInputService } from '../parity-input.service.js';

describe('ParityInputService', () => {
  const directories: string[] = [];
  const service = new ParityInputService();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns undefined when a source revision has no parity files', () => {
    expect(service.fromSource(source())).toBeUndefined();
  });

  it('loads and hashes the conventional GitHub parity files', () => {
    const root = source();
    const directory = join(root, '.hibiscus', 'parity');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'session.jsonl'), '{"index":1}\n');
    writeFileSync(join(directory, 'noise.json'), '{"rules":[]}\n');

    const first = service.fromSource(root);
    const second = service.fromSource(root);

    expect(first).toMatchObject({
      record: join(directory, 'session.jsonl'),
      noise: join(directory, 'noise.json'),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(second?.hash).toBe(first?.hash);
  });

  it('rejects an incomplete or malformed parity baseline', () => {
    const root = source();
    const directory = join(root, '.hibiscus', 'parity');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'session.jsonl'), '{"index":1}\n');
    expect(() => service.fromSource(root)).toThrow('Both .hibiscus/parity');

    writeFileSync(join(directory, 'noise.json'), '{');
    expect(() => service.fromSource(root)).toThrow(
      'Parity noise.json is not valid JSON',
    );
  });

  function source(): string {
    const directory = mkdtempSync(join(tmpdir(), 'parity-source-'));
    directories.push(directory);
    return directory;
  }
});
