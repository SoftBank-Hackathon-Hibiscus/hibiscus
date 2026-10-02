import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('authorized keys command', () => {
  it('returns one restricted key with assigned forward ports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hibiscus-authorized-key-'));
    const databaseFile = join(directory, 'test.db');
    const database = new Database(databaseFile);
    database.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        ssh_public_key TEXT,
        ssh_key_fingerprint TEXT,
        ssh_enrolled_at TEXT
      );
      CREATE TABLE routing_targets (
        agent_id TEXT,
        kind TEXT,
        enabled INTEGER,
        gateway_port INTEGER
      );
      INSERT INTO agents VALUES (
        'agent-1',
        'online',
        'ssh-ed25519 AAAATEST hibiscus:agent-1',
        'SHA256:test',
        '2026-10-02T00:00:00.000Z'
      );
      INSERT INTO routing_targets VALUES ('agent-1', 'onprem', 1, 20001);
      INSERT INTO routing_targets VALUES ('agent-1', 'onprem', 1, 20000);
    `);
    database.close();

    try {
      const output = await runCommand(databaseFile, 'SHA256:test');
      expect(output).toBe(
        'restrict,port-forwarding,permitlisten="127.0.0.1:20000",permitlisten="127.0.0.1:20001" ssh-ed25519 AAAATEST hibiscus:agent-1\n',
      );
      const revoked = new Database(databaseFile);
      revoked.prepare("UPDATE agents SET status = 'revoked'").run();
      revoked.close();
      expect(await runCommand(databaseFile, 'SHA256:test')).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function runCommand(
  databaseFile: string,
  fingerprint: string,
): Promise<string> {
  const script = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../scripts/authorized-keys-command.mjs',
  );
  return new Promise((resolveOutput, reject) => {
    execFile(
      process.execPath,
      [script, databaseFile, fingerprint],
      { encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}
