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

// cosign 이 직접 여는 KMS 키 주소 (예: gcpkms://projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>). 파일이 아니라서 존재 확인 안 함
const KMS_KEY_RE = /^(gcpkms|awskms|azurekms|hashivault):\/\/./;

/** 파일 경로가 아니라 KMS 키 주소인지 */
export function isKmsKey(key: string): boolean {
  return KMS_KEY_RE.test(key);
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
    if (!isKmsKey(this.keyPath) && !existsSync(this.keyPath)) throw new SignerError("KEY_MISSING", `cosign 키 파일이 없음: ${this.keyPath}`);
    const args = ["sign", "--yes", "--key", this.keyPath];
    // v3 는 --use-signing-config=false 없이 --tlog-upload=false 만 주면 에러
    if (this.options.noTlog) args.push("--use-signing-config=false", "--tlog-upload=false");
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    // -- 뒤라서 이미지 자리에 옵션처럼 생긴 값이 와도 옵션으로 안 읽힘
    args.push("--", imageRef);
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
  /** 이 키로 확인되는 서명 전부의 주석. 서명이 없으면 빈 배열 */
  signatures(imageRef: string): Promise<Array<Record<string, string>>>;
}

export class CosignVerifier implements ImageVerifier {
  constructor(
    private readonly pubKeyPath: string,
    private readonly cosignBin = "cosign",
    private readonly options: CosignOptions = {},
  ) {}

  async verify(imageRef: string, annotations: Record<string, string>): Promise<void> {
    await this.run(imageRef, annotations);
  }

  async signatures(imageRef: string): Promise<Array<Record<string, string>>> {
    let stdout: string;
    try {
      stdout = await this.run(imageRef, {});
    } catch (e) {
      // 서명이 없거나 이 키로 확인되는 게 없음
      if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") return [];
      throw e;
    }
    // stdout 은 서명 payload 의 JSON 배열. optional 에 -a 주석이 들어 있음
    const out: Array<Record<string, string>> = [];
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("[")) continue;
      for (const payload of JSON.parse(line) as Array<{ optional?: Record<string, unknown> }>) {
        const optional = payload.optional ?? {};
        out.push(Object.fromEntries(Object.entries(optional).filter((kv): kv is [string, string] => typeof kv[1] === "string")));
      }
    }
    return out;
  }

  private async run(imageRef: string, annotations: Record<string, string>): Promise<string> {
    if (!isKmsKey(this.pubKeyPath) && !existsSync(this.pubKeyPath)) throw new SignerError("KEY_MISSING", `cosign 공개키 파일이 없음: ${this.pubKeyPath}`);
    const args = ["verify", "--key", this.pubKeyPath];
    if (this.options.noTlog) args.push("--insecure-ignore-tlog=true");
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    args.push("--", imageRef);
    try {
      const { stdout } = await execFileAsync(this.cosignBin, args, { env: process.env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { code?: unknown; killed?: boolean };
      if (err.code === "ENOENT") throw new SignerError("COSIGN_MISSING", `cosign 실행 파일이 없음: ${this.cosignBin}`);
      if (err.killed) throw new SignerError("VERIFY_TIMEOUT", "cosign verify 시간 초과 (180초)");
      const stderr = lastStderrLine(e);
      // 키·레지스트리를 못 쓴 건 설정 문제라 실행 오류(2). 나머지(서명 없음, 주석 불일치 등)만 검증 실패(1)
      if (KEY_ERROR_RE.test(stderr)) throw new SignerError("KEY_UNAVAILABLE", `cosign 공개키를 못 읽음: ${stderr}`);
      if (REGISTRY_ERROR_RE.test(stderr)) throw new SignerError("REGISTRY_UNAVAILABLE", `레지스트리에 접근하지 못함: ${stderr}`);
      throw new SignerError("SIGNATURE_INVALID", `cosign verify 실패${stderr ? `: ${stderr}` : ""}`);
    }
  }
}

// cosign v3.1.3 오류 문구 기준
const KEY_ERROR_RE = /loading verifier from key opts|loading public key/;
const REGISTRY_ERROR_RE = /dial tcp|connection refused|no such host|i\/o timeout|TLS handshake|UNAUTHORIZED|DENIED/;

function lastStderrLine(e: unknown): string {
  return String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() ?? "";
}

/** cosign 없이 연결만 확인할 때. 실제 배포용 아님 */
export class DryRunSigner implements ImageSigner {
  async sign(imageRef: string): Promise<string> {
    return `dry-run:${imageRef}`;
  }
}
