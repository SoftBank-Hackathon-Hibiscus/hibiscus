// cosign 로컬 키 서명. -a 로 run_id, plan_hash 를 붙여서 배포 쪽에서 cosign verify -a plan_hash=... 로 확인 가능
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { SignerError } from "./io.js";

const execFileAsync = promisify(execFile);

export interface ImageSigner {
  /** 서명하고 signature_ref 반환 */
  sign(imageRef: string, annotations: Record<string, string>): Promise<string>;
}

// 태그·digest 없는 저장소 주소
const IMAGE_REPO_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

export function imageRefOf(imageRepo: string, digest: string): string {
  if (!IMAGE_REPO_RE.test(imageRepo)) {
    throw new SignerError("IMAGE_REPO_INVALID", `이미지 저장소 형식 오류 (태그·digest 없이 <호스트>/<경로>): ${imageRepo}`);
  }
  return `${imageRepo}@${digest}`;
}

export class CosignSigner implements ImageSigner {
  constructor(
    private readonly keyPath: string,
    private readonly cosignBin = "cosign",
  ) {}

  async sign(imageRef: string, annotations: Record<string, string>): Promise<string> {
    if (!existsSync(this.keyPath)) throw new SignerError("KEY_MISSING", `cosign 키 파일이 없음: ${this.keyPath}`);
    const args = ["sign", "--yes", "--key", this.keyPath];
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    args.push(imageRef);
    try {
      // 비밀번호는 COSIGN_PASSWORD 로만 받음
      await execFileAsync(this.cosignBin, args, { env: process.env, timeout: 180_000 });
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() ?? "";
      throw new SignerError("SIGN_FAILED", `cosign 서명 실패${stderr ? `: ${stderr}` : ""}`);
    }
    return `cosign:${imageRef}`;
  }
}

/** cosign 없이 연결만 확인할 때. 실제 배포용 아님 */
export class DryRunSigner implements ImageSigner {
  async sign(imageRef: string): Promise<string> {
    return `dry-run:${imageRef}`;
  }
}
