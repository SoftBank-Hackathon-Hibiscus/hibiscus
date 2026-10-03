// cosign 로컬 키 서명·확인. -a 주석으로 sign_result 필드를 붙여서 cosign verify -a ... 로 그대로인지 확인 가능
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

export interface CosignOptions {
  /** Rekor(투명성 로그)에 안 올림. 이렇게 서명한 이미지는 verify 에도 --insecure-ignore-tlog=true 필요 */
  noTlog?: boolean;
}

export class CosignSigner implements ImageSigner {
  constructor(
    private readonly keyPath: string,
    private readonly cosignBin = "cosign",
    private readonly options: CosignOptions = {},
  ) {}

  async sign(imageRef: string, annotations: Record<string, string>): Promise<string> {
    if (!existsSync(this.keyPath)) throw new SignerError("KEY_MISSING", `cosign 키 파일이 없음: ${this.keyPath}`);
    const args = ["sign", "--yes", "--key", this.keyPath];
    // v3 는 --use-signing-config=false 없이 --tlog-upload=false 만 주면 에러
    if (this.options.noTlog) args.push("--use-signing-config=false", "--tlog-upload=false");
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    args.push(imageRef);
    try {
      // 비밀번호는 COSIGN_PASSWORD 로만 받음
      await execFileAsync(this.cosignBin, args, { env: process.env, timeout: 180_000 });
    } catch (e) {
      const stderr = lastStderrLine(e);
      throw new SignerError("SIGN_FAILED", `cosign 서명 실패${stderr ? `: ${stderr}` : ""}`);
    }
    return `cosign:${imageRef}`;
  }
}

export interface ImageVerifier {
  /** 주석이 전부 맞는 서명이 하나라도 있으면 통과. 아니면 SIGNATURE_INVALID */
  verify(imageRef: string, annotations: Record<string, string>): Promise<void>;
}

export class CosignVerifier implements ImageVerifier {
  constructor(
    private readonly pubKeyPath: string,
    private readonly cosignBin = "cosign",
    private readonly options: CosignOptions = {},
  ) {}

  async verify(imageRef: string, annotations: Record<string, string>): Promise<void> {
    if (!existsSync(this.pubKeyPath)) throw new SignerError("KEY_MISSING", `cosign 공개키 파일이 없음: ${this.pubKeyPath}`);
    const args = ["verify", "--key", this.pubKeyPath];
    if (this.options.noTlog) args.push("--insecure-ignore-tlog=true");
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    args.push(imageRef);
    try {
      // 통과하면 stdout 에 서명 내용이 나옴. 결과는 종료 코드로만 봄
      await execFileAsync(this.cosignBin, args, { env: process.env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      const err = e as { code?: unknown; killed?: boolean };
      if (err.code === "ENOENT") throw new SignerError("COSIGN_MISSING", `cosign 실행 파일이 없음: ${this.cosignBin}`);
      if (err.killed) throw new SignerError("VERIFY_TIMEOUT", "cosign verify 시간 초과 (180초)");
      const stderr = lastStderrLine(e);
      throw new SignerError("SIGNATURE_INVALID", `cosign verify 실패${stderr ? `: ${stderr}` : ""}`);
    }
  }
}

function lastStderrLine(e: unknown): string {
  return String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() ?? "";
}

/** cosign 없이 연결만 확인할 때. 실제 배포용 아님 */
export class DryRunSigner implements ImageSigner {
  async sign(imageRef: string): Promise<string> {
    return `dry-run:${imageRef}`;
  }
}
