import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import ssh2 from "ssh2";
import type { AgentConfig } from "./config.js";
import type { BackendAgentClient, SshEnrollment } from "./types.js";
import { FatalAgentError } from "./types.js";

interface EnrollmentMarker {
  enrollment_token_hash: string;
  fingerprint: string;
  enrolled_at: string;
  ssh: SshEnrollment["ssh"];
}

const { utils } = ssh2;

export class SshIdentity {
  constructor(
    private readonly config: AgentConfig,
    private readonly backend: BackendAgentClient,
  ) {}

  async ensure(): Promise<void> {
    const identity = await this.ensureKeyPair();
    const token = this.config.sshEnrollmentToken;
    const marker = await this.readMarker();
    if (marker?.ssh) this.applySshSettings(marker.ssh);
    if (!token) {
      this.requireSshSettings();
      return;
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (marker?.enrollment_token_hash === tokenHash) {
      this.requireSshSettings();
      return;
    }

    const enrollment = await this.backend.enrollSsh(token, identity.publicKey);
    if (enrollment.agent_id !== this.config.agentId) {
      throw new FatalAgentError(
        "SSH enrollment returned a different Agent identifier",
      );
    }
    if (enrollment.fingerprint !== identity.fingerprint) {
      throw new FatalAgentError("SSH enrollment fingerprint does not match");
    }
    this.applySshSettings(enrollment.ssh);
    await this.writeAtomic(
      this.markerPath(),
      `${JSON.stringify(
        {
          enrollment_token_hash: tokenHash,
          fingerprint: identity.fingerprint,
          enrolled_at: enrollment.enrolled_at,
          ssh: enrollment.ssh,
        } satisfies EnrollmentMarker,
        null,
        2,
      )}\n`,
      0o600,
    );
    this.requireSshSettings();
  }

  private async ensureKeyPair(): Promise<{
    publicKey: string;
    fingerprint: string;
  }> {
    let privateKey: string;
    try {
      privateKey = await readFile(this.config.sshIdentityFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!this.config.sshEnrollmentToken) {
        throw new FatalAgentError(
          "SSH enrollment token is required to create the first identity",
        );
      }
      const generated = utils.generateKeyPairSync("ed25519", {
        comment: `hibiscus:${this.config.agentId}`,
      });
      privateKey = generated.private;
      await this.writeAtomic(this.config.sshIdentityFile, privateKey, 0o600);
    }

    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || !parsed.isPrivateKey()) {
      throw new FatalAgentError("SSH identity file is not a private key");
    }
    if (parsed.type !== "ssh-ed25519") {
      throw new FatalAgentError("SSH identity must use ED25519");
    }
    const publicBytes = parsed.getPublicSSH();
    const publicKey = `${parsed.type} ${publicBytes.toString("base64")} hibiscus:${this.config.agentId}`;
    await this.writeAtomic(
      `${this.config.sshIdentityFile}.pub`,
      `${publicKey}\n`,
      0o644,
    );
    return {
      publicKey,
      fingerprint: sshKeyFingerprint(publicBytes),
    };
  }

  private async readMarker(): Promise<EnrollmentMarker | undefined> {
    try {
      return JSON.parse(
        await readFile(this.markerPath(), "utf8"),
      ) as EnrollmentMarker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private markerPath(): string {
    return `${this.config.sshIdentityFile}.enrolled`;
  }

  private applySshSettings(settings: SshEnrollment["ssh"]): void {
    this.config.sshHost = settings.host;
    this.config.sshPort = settings.port;
    this.config.sshUser = settings.user;
    this.config.sshHostKeySha256 = settings.host_key_sha256;
  }

  private requireSshSettings(): void {
    if (
      !this.config.sshHost ||
      !this.config.sshUser ||
      !this.config.sshHostKeySha256
    ) {
      throw new FatalAgentError(
        "SSH settings require enrollment or explicit configuration",
      );
    }
  }

  private async writeAtomic(
    path: string,
    content: string,
    mode: number,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, path);
  }
}

export function sshKeyFingerprint(publicKey: Buffer): string {
  return `SHA256:${createHash("sha256")
    .update(publicKey)
    .digest("base64")
    .replace(/=+$/, "")}`;
}
