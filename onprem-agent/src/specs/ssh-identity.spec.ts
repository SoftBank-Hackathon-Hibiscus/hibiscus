import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import type { AgentConfig } from "../config.js";
import { SshIdentity, sshKeyFingerprint } from "../ssh-identity.js";
import type { BackendAgentClient } from "../types.js";

const { utils } = ssh2;

void test("generates and enrolls one ED25519 identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hibiscus-ssh-identity-"));
  const config = agentConfig(join(directory, "agent_ed25519"));
  let enrollmentCalls = 0;
  const backend = {
    async enrollSsh(token: string, publicKey: string) {
      enrollmentCalls += 1;
      assert.equal(token, config.sshEnrollmentToken);
      const parsed = utils.parseKey(publicKey);
      assert.ok(!(parsed instanceof Error));
      return {
        agent_id: config.agentId,
        fingerprint: sshKeyFingerprint(parsed.getPublicSSH()),
        enrolled_at: new Date().toISOString(),
        ssh: {
          host: "gateway.example.com",
          port: 2222,
          user: "hibiscus-agent",
          host_key_sha256: `SHA256:${"A".repeat(43)}`,
        },
      };
    },
  } as unknown as BackendAgentClient;

  try {
    const identity = new SshIdentity(config, backend);
    await identity.ensure();
    await identity.ensure();

    assert.equal(enrollmentCalls, 1);
    assert.equal(config.sshHost, "gateway.example.com");
    assert.equal(config.sshPort, 2222);
    assert.match(await readFile(config.sshIdentityFile, "utf8"), /PRIVATE KEY/);
    assert.match(
      await readFile(`${config.sshIdentityFile}.pub`, "utf8"),
      /^ssh-ed25519 /,
    );
    assert.equal((await stat(config.sshIdentityFile)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function agentConfig(identityFile: string): AgentConfig {
  return {
    apiUrl: new URL("https://backend.example.com"),
    agentId: "agent-1",
    token: "x".repeat(32),
    cosignPublicKey: "/keys/cosign.pub",
    stateFile: "/data/agent-state.json",
    pollIntervalMs: 2_000,
    heartbeatIntervalMs: 10_000,
    backendRequestTimeoutMs: 10_000,
    commandTimeoutMs: 100_000,
    dockerStopTimeoutSeconds: 10,
    dockerCommand: "docker",
    cosignCommand: "cosign",
    cosignAllowInsecureRegistry: false,
    cosignInsecureIgnoreTlog: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshIdentityFile: identityFile,
    sshEnrollmentToken: "e".repeat(43),
    sshHostKeySha256: "",
    sshReadyTimeoutMs: 10_000,
    sshForwardPollIntervalMs: 2_000,
    sshServerAliveIntervalSeconds: 15,
    sshServerAliveCountMax: 3,
    sshSessionMaxMs: 900_000,
  };
}
