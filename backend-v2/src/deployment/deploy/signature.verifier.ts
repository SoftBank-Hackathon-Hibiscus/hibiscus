import { CommandRunner } from '../../infrastructure/command-runner.js';
import {
  DeployRejected,
  type SignatureVerifierPort,
} from '../types/deploy-result.type.js';
import type { DeploymentSignResult } from '../types/deployment.type.js';

export interface SignatureVerifierOptions {
  cosignCommand: string;
  publicKey: string;
  cwd: string;
  timeoutMs: number;
}

/**
 * 배포 직전 서명 확인 ("도장 검사"). 비용이 없는 검사를 먼저 하고 cosign 은 마지막에 부른다.
 * 서명 주석 run_id·plan_hash 까지 묶어서, 다른 실행이나 다른 계획의 서명으로는 배포할 수 없게 한다.
 */
export class SignatureVerifier implements SignatureVerifierPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: SignatureVerifierOptions,
  ) {}

  async verify(sign: DeploymentSignResult, imageRepo: string) {
    const ref = sign.signature_ref;
    if (ref.startsWith('dry-run:'))
      throw new DeployRejected(
        `Dry-run signatures are never deployed (${ref})`,
      );
    if (!ref.startsWith('cosign:'))
      throw new DeployRejected(`Unsupported signature reference: ${ref}`);
    const imageRef = ref.slice('cosign:'.length);
    if (!imageRef.endsWith(`@${sign.digest}`))
      throw new DeployRejected(
        'Signed image digest does not match sign_result.digest',
      );
    if (imageRef !== `${imageRepo}@${sign.digest}`)
      throw new DeployRejected(
        'Signed image repository does not match the application image_repo',
      );

    const result = await this.runner.run({
      command: this.options.cosignCommand,
      args: [
        'verify',
        '--key',
        this.options.publicKey,
        '-a',
        `run_id=${sign.run_id}`,
        '-a',
        `plan_hash=${sign.plan_hash}`,
        imageRef,
      ],
      cwd: this.options.cwd,
      timeoutMs: this.options.timeoutMs,
    });
    if (result.timedOut)
      throw new DeployRejected('Signature verification timed out');
    if (result.code !== 0) {
      const lines = result.stderr.trim().split(/\r?\n/).filter(Boolean);
      throw new DeployRejected(
        `Signature verification failed: ${lines.at(-1) ?? 'no output'}`,
      );
    }
    return { imageRef, key: this.options.publicKey };
  }
}
