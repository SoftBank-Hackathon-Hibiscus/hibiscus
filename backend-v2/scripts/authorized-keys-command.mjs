#!/usr/bin/env node

import Database from 'better-sqlite3';

const [databaseFile, fingerprint] = process.argv.slice(2);
if (!databaseFile || !fingerprint) process.exit(1);

try {
  const database = new Database(databaseFile, {
    readonly: true,
    fileMustExist: true,
  });
  const agent = database
    .prepare(
      `SELECT id, ssh_public_key
       FROM agents
       WHERE ssh_key_fingerprint = ?
         AND ssh_enrolled_at IS NOT NULL
         AND status != 'revoked'`,
    )
    .get(fingerprint);
  if (!agent) process.exit(0);

  const forwards = database
    .prepare(
      `SELECT gateway_port
       FROM routing_targets
       WHERE agent_id = ?
         AND kind = 'onprem'
         AND enabled = 1
         AND gateway_port IS NOT NULL
       ORDER BY gateway_port`,
    )
    .all(agent.id);
  const options = [
    'restrict',
    ...(forwards.length > 0 ? ['port-forwarding'] : []),
    ...forwards.map(
      ({ gateway_port }) =>
        `permitlisten="127.0.0.1:${Number(gateway_port)}"`,
    ),
  ];
  process.stdout.write(`${options.join(',')} ${agent.ssh_public_key}\n`);
  database.close();
} catch (error) {
  process.stderr.write(
    `[hibiscus-authorized-key] ${error instanceof Error ? error.message : 'Lookup failed'}\n`,
  );
  process.exit(1);
}
