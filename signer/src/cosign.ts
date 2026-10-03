// cosign 로컬 키 서명·확인. -a 주석으로 sign_result 필드를 붙여서 cosign verify -a ... 로 그대로인지 확인 가능.
// 배포 증명서(in-toto attestation)를 붙이고 cosign verify-attestation(+Rego 정책)으로 확인하는 것도 여기서
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SignerError } from "./io.js";

const execFileAsync = promisify(execFile);

/** 파일 내용에 서명하고 sigstore bundle(JSON) 반환. 감사 로그 끝 고정에 씀 */
export interface BlobSigner {
  signBlob(content: string): Promise<unknown>;
}

/** signBlob 으로 만든 bundle 이 이 내용에 대한 믿는 키의 서명인지. 아니면 SIGNATURE_INVALID */
export interface BlobVerifier {
  verifyBlob(content: string, bundle: unknown): Promise<void>;
}

export interface ImageSigner {
  /** 서명하고 signature_ref 반환 */
  sign(imageRef: string, annotations: Record<string, string>): Promise<string>;
  /** 서명된 배포 증명서(in-toto Statement)를 이미지에 붙임. 시험 실행 서명기는 없음 */
  attest?(imageRef: string, predicateType: string, predicate: unknown): Promise<void>;
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

// v2 는 서명·확인 옵션(--use-signing-config 등)과 출력이 달라서 v3 부터만 씀
export const MIN_COSIGN_MAJOR = 3;
const checkedVersions = new Map<string, Promise<string>>();

/** cosign 이 v3 이상인지 실행 파일마다 한 번만 확인. 버전 문자열 반환 */
export function ensureCosignVersion(cosignBin: string): Promise<string> {
  let pending = checkedVersions.get(cosignBin);
  if (!pending) {
    pending = readCosignVersion(cosignBin);
    checkedVersions.set(cosignBin, pending);
    // 실패는 기억하지 않음 (설치 후 다시 시도할 수 있게)
    pending.catch(() => checkedVersions.delete(cosignBin));
  }
  return pending;
}

async function readCosignVersion(cosignBin: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(cosignBin, ["version", "--json"], { env: process.env, timeout: 30_000 }));
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") throw new SignerError("COSIGN_MISSING", `cosign 실행 파일이 없음: ${cosignBin}`);
    throw new SignerError("COSIGN_VERSION_UNKNOWN", `cosign 버전을 확인하지 못함${lastStderrLine(e) ? `: ${lastStderrLine(e)}` : ""}`);
  }
  let version = "";
  try {
    version = String((JSON.parse(stdout) as { gitVersion?: unknown }).gitVersion ?? "");
  } catch {
    // 아래에서 처리
  }
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  if (!Number.isFinite(major)) throw new SignerError("COSIGN_VERSION_UNKNOWN", `cosign 버전을 읽지 못함: ${stdout.trim().slice(0, 80)}`);
  if (major < MIN_COSIGN_MAJOR) throw new SignerError("COSIGN_VERSION", `cosign v${MIN_COSIGN_MAJOR} 이상이 필요함 (지금 ${version})`);
  return version;
}

export interface CosignOptions {
  /** Rekor(투명성 로그)에 안 올림. 이렇게 서명한 이미지는 verify 에도 --insecure-ignore-tlog=true 필요 */
  noTlog?: boolean;
  /** cosign 에 필요한 환경변수만 넘김 (backend 의 다른 비밀값이 cosign 프로세스로 새지 않게) */
  minimalEnv?: boolean;
}

// cosign 이 서명·확인·레지스트리 인증·KMS 에 쓰는 환경변수. 나머지(DB 주소, GitHub App 키, JWT 비밀값 등)는 안 넘김
const COSIGN_ENV_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "DOCKER_CONFIG", "REGISTRY_AUTH_FILE", "TUF_ROOT", "GOOGLE_APPLICATION_CREDENTIALS", "GCE_METADATA_HOST", "GCE_METADATA_IP", "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);
const COSIGN_ENV_PREFIXES = ["COSIGN_", "SIGSTORE_", "REKOR_", "CLOUDSDK_", "GOOGLE_", "AWS_", "AZURE_", "VAULT_"];

/** minimalEnv 면 cosign 에 필요한 것만 남긴 환경변수 */
export function cosignEnv(options: CosignOptions, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!options.minimalEnv) return env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => COSIGN_ENV_NAMES.has(name) || COSIGN_ENV_PREFIXES.some((p) => name.startsWith(p))));
}

export class CosignSigner implements ImageSigner, BlobSigner {
  constructor(
    private readonly keyPath: string,
    private readonly cosignBin = "cosign",
    private readonly options: CosignOptions = {},
  ) {}

  async sign(imageRef: string, annotations: Record<string, string>): Promise<string> {
    if (!isKmsKey(this.keyPath) && !existsSync(this.keyPath)) throw new SignerError("KEY_MISSING", `cosign 키 파일이 없음: ${this.keyPath}`);
    await ensureCosignVersion(this.cosignBin);
    const args = ["sign", "--yes", "--key", this.keyPath, ...this.tlogArgs()];
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    // -- 뒤라서 이미지 자리에 옵션처럼 생긴 값이 와도 옵션으로 안 읽힘
    args.push("--", imageRef);
    try {
      // 비밀번호는 COSIGN_PASSWORD 로만 받음
      await execFileAsync(this.cosignBin, args, { env: cosignEnv(this.options), timeout: 180_000 });
    } catch (e) {
      const stderr = lastStderrLine(e);
      throw new SignerError("SIGN_FAILED", `cosign 서명 실패${stderr ? `: ${stderr}` : ""}`);
    }
    return `cosign:${imageRef}`;
  }

  async attest(imageRef: string, predicateType: string, predicate: unknown): Promise<void> {
    if (!isKmsKey(this.keyPath) && !existsSync(this.keyPath)) throw new SignerError("KEY_MISSING", `cosign 키 파일이 없음: ${this.keyPath}`);
    await ensureCosignVersion(this.cosignBin);
    const dir = mkdtempSync(join(tmpdir(), "signer-attest-"));
    const predicatePath = join(dir, "predicate.json");
    writeFileSync(predicatePath, JSON.stringify(predicate), "utf8");
    const args = ["attest", "--yes", "--key", this.keyPath, ...this.tlogArgs(), "--type", predicateType, "--predicate", predicatePath, "--", imageRef];
    try {
      await execFileAsync(this.cosignBin, args, { env: cosignEnv(this.options), timeout: 180_000 });
    } catch (e) {
      const stderr = lastStderrLine(e);
      throw new SignerError("ATTEST_FAILED", `cosign 배포 증명서 붙이기 실패${stderr ? `: ${stderr}` : ""}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async signBlob(content: string): Promise<unknown> {
    if (!isKmsKey(this.keyPath) && !existsSync(this.keyPath)) throw new SignerError("KEY_MISSING", `cosign 키 파일이 없음: ${this.keyPath}`);
    await ensureCosignVersion(this.cosignBin);
    const dir = mkdtempSync(join(tmpdir(), "signer-blob-"));
    const blobPath = join(dir, "blob");
    const bundlePath = join(dir, "bundle.json");
    writeFileSync(blobPath, content, "utf8");
    try {
      await execFileAsync(this.cosignBin, ["sign-blob", "--yes", "--key", this.keyPath, ...this.tlogArgs(), "--bundle", bundlePath, "--", blobPath], {
        env: cosignEnv(this.options),
        timeout: 180_000,
      });
      return JSON.parse(readFileSync(bundlePath, "utf8")) as unknown;
    } catch (e) {
      if (e instanceof SyntaxError) throw new SignerError("SIGN_FAILED", "cosign sign-blob bundle 이 JSON 이 아님");
      const stderr = lastStderrLine(e);
      throw new SignerError("SIGN_FAILED", `cosign sign-blob 실패${stderr ? `: ${stderr}` : ""}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // v3 는 --use-signing-config=false 없이 --tlog-upload=false 만 주면 에러
  private tlogArgs(): string[] {
    return this.options.noTlog ? ["--use-signing-config=false", "--tlog-upload=false"] : [];
  }
}

export interface ImageVerifier {
  /** 주석이 전부 맞는 서명이 하나라도 있으면 통과. 아니면 SIGNATURE_INVALID */
  verify(imageRef: string, annotations: Record<string, string>): Promise<void>;
  /** 이 키로 확인되는 서명 전부의 주석. 서명이 없으면 빈 배열 */
  signatures(imageRef: string): Promise<Array<Record<string, string>>>;
  /**
   * 이 키로 확인되는 배포 증명서(in-toto Statement) 전부. policyPath 를 주면 cosign 이 Rego 정책도 검사.
   * 증명서가 없거나 서명이 안 맞으면 SIGNATURE_INVALID, 정책에 걸리면 POLICY_DENIED
   */
  attestations?(imageRef: string, predicateType: string, policyPath?: string): Promise<unknown[]>;
}

export class CosignVerifier implements ImageVerifier, BlobVerifier {
  constructor(
    private readonly pubKeyPath: string,
    private readonly cosignBin = "cosign",
    private readonly options: CosignOptions = {},
  ) {}

  async verify(imageRef: string, annotations: Record<string, string>): Promise<void> {
    try {
      await this.run(this.verifyArgs(annotations, imageRef));
    } catch (e) {
      // 단일 결과 검증에서는 서명이 없는 것도 검증 실패다.
      if (e instanceof SignerError && e.code === "SIGNATURE_NOT_FOUND") throw new SignerError("SIGNATURE_INVALID", e.message);
      throw e;
    }
  }

  async signatures(imageRef: string): Promise<Array<Record<string, string>>> {
    let stdout: string;
    try {
      stdout = await this.run(this.verifyArgs({}, imageRef));
    } catch (e) {
      // 서명 부재가 명시된 경우만 빈 목록이다. 검증·실행 오류로 감사 검사를 통과시키지 않는다.
      if (e instanceof SignerError && e.code === "SIGNATURE_NOT_FOUND") return [];
      throw e;
    }
    // stdout 은 서명 payload 의 JSON 배열. optional 에 -a 주석이 들어 있음
    try {
      const payloads: unknown = JSON.parse(stdout);
      if (!Array.isArray(payloads)) throw new Error("JSON 배열이 아님");
      return payloads.map((payload: unknown) => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("서명 payload 형식 오류");
        const optional: unknown = (payload as { optional?: unknown }).optional ?? {};
        if (optional === null || typeof optional !== "object" || Array.isArray(optional)) throw new Error("서명 주석 형식 오류");
        return Object.fromEntries(Object.entries(optional).filter((kv): kv is [string, string] => typeof kv[1] === "string"));
      });
    } catch {
      throw new SignerError("VERIFY_OUTPUT_INVALID", "cosign verify 성공 출력이 서명 payload JSON 배열이 아님");
    }
  }

  async attestations(imageRef: string, predicateType: string, policyPath?: string): Promise<unknown[]> {
    const args = ["verify-attestation", "--key", this.pubKeyPath, ...this.tlogArgs(), "--type", predicateType];
    if (policyPath !== undefined) args.push("--policy", policyPath);
    args.push("--", imageRef);
    let stdout: string;
    try {
      stdout = await this.run(args);
    } catch (e) {
      if (e instanceof SignerError && e.code === "SIGNATURE_NOT_FOUND") throw new SignerError("SIGNATURE_INVALID", e.message);
      throw e;
    }
    // stdout 은 줄마다 DSSE 봉투 JSON. payload(base64)를 풀면 in-toto Statement
    try {
      return stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => {
          const envelope = JSON.parse(line) as { payload?: unknown };
          if (typeof envelope.payload !== "string") throw new Error("payload 없음");
          return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as unknown;
        });
    } catch {
      throw new SignerError("VERIFY_OUTPUT_INVALID", "cosign verify-attestation 출력이 DSSE 봉투 JSON 이 아님");
    }
  }

  async verifyBlob(content: string, bundle: unknown): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "signer-blob-"));
    const blobPath = join(dir, "blob");
    const bundlePath = join(dir, "bundle.json");
    writeFileSync(blobPath, content, "utf8");
    writeFileSync(bundlePath, JSON.stringify(bundle), "utf8");
    try {
      await this.run(["verify-blob", "--key", this.pubKeyPath, ...this.tlogArgs(), "--bundle", bundlePath, "--", blobPath]);
    } catch (e) {
      // bundle 은 파일에서 온 값이라 망가진 bundle(형식 오류, cosign panic 포함)도 서명이 안 맞는 것으로 봄. 키·cosign 없음·시간 초과는 그대로 실행 오류
      if (e instanceof SignerError && (e.code === "SIGNATURE_NOT_FOUND" || e.code === "VERIFY_FAILED")) throw new SignerError("SIGNATURE_INVALID", e.message);
      throw e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private verifyArgs(annotations: Record<string, string>, imageRef: string): string[] {
    const args = ["verify", "--key", this.pubKeyPath, ...this.tlogArgs()];
    for (const [key, value] of Object.entries(annotations)) args.push("-a", `${key}=${value}`);
    args.push("--", imageRef);
    return args;
  }

  private tlogArgs(): string[] {
    return this.options.noTlog ? ["--insecure-ignore-tlog=true"] : [];
  }

  private async run(args: string[]): Promise<string> {
    if (!isKmsKey(this.pubKeyPath) && !existsSync(this.pubKeyPath)) throw new SignerError("KEY_MISSING", `cosign 공개키 파일이 없음: ${this.pubKeyPath}`);
    await ensureCosignVersion(this.cosignBin);
    try {
      const { stdout } = await execFileAsync(this.cosignBin, args, { env: cosignEnv(this.options), timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { code?: unknown; killed?: boolean };
      if (err.code === "ENOENT") throw new SignerError("COSIGN_MISSING", `cosign 실행 파일이 없음: ${this.cosignBin}`);
      if (err.killed) throw new SignerError("VERIFY_TIMEOUT", "cosign verify 시간 초과 (180초)");
      const stderr = lastStderrLine(e);
      // 키·레지스트리를 못 쓴 건 설정 문제라 실행 오류(2). 나머지(서명 없음, 주석 불일치 등)만 검증 실패(1)
      if (KEY_ERROR_RE.test(stderr)) throw new SignerError("KEY_UNAVAILABLE", `cosign 공개키를 못 읽음: ${stderr}`);
      if (REGISTRY_ERROR_RE.test(stderr)) throw new SignerError("REGISTRY_UNAVAILABLE", `레지스트리에 접근하지 못함: ${stderr}`);
      if (typeof err.code === "number" && POLICY_ERROR_RE.test(stderr)) throw new SignerError("POLICY_DENIED", `배포 증명서가 정책에 맞지 않음: ${stderr}`);
      if (typeof err.code === "number" && NO_SIGNATURE_RE.test(stderr)) throw new SignerError("SIGNATURE_NOT_FOUND", `cosign verify 실패: ${stderr}`);
      if (typeof err.code === "number" && SIGNATURE_ERROR_RE.test(stderr)) throw new SignerError("SIGNATURE_INVALID", `cosign verify 실패: ${stderr}`);
      throw new SignerError("VERIFY_FAILED", `cosign verify 실행 실패${stderr ? `: ${stderr}` : ""}`);
    }
  }
}

// cosign v3.1.3 오류 문구 기준
const KEY_ERROR_RE = /loading verifier from key opts|loading public key/;
const REGISTRY_ERROR_RE = /dial tcp|connection refused|no such host|i\/o timeout|TLS handshake|UNAUTHORIZED|DENIED/;
// 실제 cosign 은 "error during command execution: no signatures found" 처럼 앞에 접두어가 붙음
const NO_SIGNATURE_RE = /(?:^|:\s*)no signatures found(?:\s|$)/i;
const SIGNATURE_ERROR_RE = /no matching (?:signatures|attestations)|none of the attestations matched|missing or incorrect annotation|not enough verified log entries|signature verification failed|failed to verify signature|invalid signature/i;
// verify-attestation --policy 에서 Rego 정책을 통과 못 함
const POLICY_ERROR_RE = /validation errors? occurred/i;

function lastStderrLine(e: unknown): string {
  return String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() ?? "";
}

/** cosign 없이 연결만 확인할 때. 실제 배포용 아님 */
export class DryRunSigner implements ImageSigner {
  async sign(imageRef: string): Promise<string> {
    return `dry-run:${imageRef}`;
  }
}

/**
 * 키 교체 중처럼 믿는 공개키가 여러 개일 때. 서명·증명서는 그중 아무 키로나 확인되면 통과.
 * 키·레지스트리 설정 오류는 숨기지 않음 (다른 키로 통과하지 못하면 그 오류를 그대로 냄)
 */
export class MultiKeyVerifier implements ImageVerifier, BlobVerifier {
  constructor(private readonly verifiers: readonly ImageVerifier[]) {
    if (verifiers.length === 0) throw new SignerError("ARG_INVALID", "믿는 공개키가 없음");
  }

  async verify(imageRef: string, annotations: Record<string, string>): Promise<void> {
    const errors: unknown[] = [];
    for (const v of this.verifiers) {
      try {
        await v.verify(imageRef, annotations);
        return;
      } catch (e) {
        errors.push(e);
      }
    }
    throw firstConfigError(errors) ?? new SignerError("SIGNATURE_INVALID", `믿는 공개키 ${this.verifiers.length}개 모두로 확인 실패: ${messages(errors)}`);
  }

  async verifyBlob(content: string, bundle: unknown): Promise<void> {
    const errors: unknown[] = [];
    for (const v of this.verifiers) {
      const blob = v as Partial<BlobVerifier>;
      if (!blob.verifyBlob) continue;
      try {
        await blob.verifyBlob(content, bundle);
        return;
      } catch (e) {
        errors.push(e);
      }
    }
    throw firstConfigError(errors) ?? new SignerError("SIGNATURE_INVALID", `믿는 공개키로 확인되는 서명이 없음: ${messages(errors)}`);
  }

  async signatures(imageRef: string): Promise<Array<Record<string, string>>> {
    const all: Array<Record<string, string>> = [];
    for (const v of this.verifiers) all.push(...(await v.signatures(imageRef)));
    return all;
  }

  async attestations(imageRef: string, predicateType: string, policyPath?: string): Promise<unknown[]> {
    const all: unknown[] = [];
    const errors: unknown[] = [];
    for (const v of this.verifiers) {
      if (!v.attestations) continue;
      try {
        all.push(...(await v.attestations(imageRef, predicateType, policyPath)));
      } catch (e) {
        // 믿는 키로 서명된 증명서가 정책을 어기면 다른 키 결과와 상관없이 거부
        if (e instanceof SignerError && e.code === "POLICY_DENIED") throw e;
        errors.push(e);
      }
    }
    if (all.length > 0) return all;
    throw firstConfigError(errors) ?? new SignerError("SIGNATURE_INVALID", `믿는 공개키로 확인되는 배포 증명서가 없음: ${messages(errors)}`);
  }
}

function firstConfigError(errors: unknown[]): unknown {
  return errors.find((e) => !(e instanceof SignerError && (e.code === "SIGNATURE_INVALID" || e.code === "SIGNATURE_NOT_FOUND")));
}

function messages(errors: unknown[]): string {
  return errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" / ").slice(0, 400);
}
