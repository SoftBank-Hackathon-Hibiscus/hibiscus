import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../infrastructure/command-runner.js';
import { SignatureVerifier } from '../deploy/signature.verifier.js';
import { DeployRejected } from '../types/deploy-result.type.js';
import type { DeploymentSignResult } from '../types/deployment.type.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;
const REPO = 'registry.example/app';

function sign(ref: string): DeploymentSignResult {
  return {
    run_id: 'run-1',
    digest: DIGEST,
    plan_hash: 'd'.repeat(64),
    targets: ['cloud_run'],
    failover_allowed: false,
    requester: 'user-1',
    approver: 'auto',
    signature_ref: ref,
    signed_at: '2026-10-02T00:00:00.000Z',
  };
}

function verifier(code = 0, stderr = '') {
  const run = vi.fn(async () => ({
    code,
    signal: null,
    stdout: '',
    stderr,
    timedOut: false,
  }));
  const subject = new SignatureVerifier({ run } as unknown as CommandRunner, {
    cosignCommand: 'cosign',
    publicKey: '/keys/cosign.pub',
    cwd: '/repo',
    timeoutMs: 1_000,
  });
  return { subject, run };
}

describe('SignatureVerifier', () => {
  it('runs cosign with run_id and plan_hash annotations', async () => {
    const { subject, run } = verifier();
    await expect(
      subject.verify(sign(`cosign:${REPO}@${DIGEST}`), REPO),
    ).resolves.toEqual({
      imageRef: `${REPO}@${DIGEST}`,
      key: '/keys/cosign.pub',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'cosign',
        args: [
          'verify',
          '--key',
          '/keys/cosign.pub',
          '-a',
          'run_id=run-1',
          '-a',
          `plan_hash=${'d'.repeat(64)}`,
          `${REPO}@${DIGEST}`,
        ],
      }),
    );
  });

  it.each([
    ['dry-run signature', 'dry-run:skeleton:run-1', REPO],
    ['unknown signature format', `kms:${REPO}@${DIGEST}`, REPO],
    ['digest mismatch', `cosign:${REPO}@sha256:${'e'.repeat(64)}`, REPO],
    [
      'repository mismatch',
      `cosign:${REPO}@${DIGEST}`,
      'registry.example/other',
    ],
  ])('rejects %s without calling cosign', async (_name, ref, repo) => {
    const { subject, run } = verifier();
    await expect(subject.verify(sign(ref), repo)).rejects.toBeInstanceOf(
      DeployRejected,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects when cosign verification fails', async () => {
    const { subject } = verifier(
      1,
      'Error: no matching signatures\nmissing or incorrect annotation',
    );
    await expect(
      subject.verify(sign(`cosign:${REPO}@${DIGEST}`), REPO),
    ).rejects.toThrow('missing or incorrect annotation');
  });
});
