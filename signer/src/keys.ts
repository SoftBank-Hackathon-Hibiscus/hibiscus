// 공개키 지문. 배포 쪽이 믿는 공개키가 몰래 바뀌지 않았는지 확인할 때 씀 (레포의 keys/cosign.pub 는 누구나 바꿀 수 있어서)
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isKmsKey } from "./cosign.js";
import { SignerError } from "./io.js";

/** 공개키(SubjectPublicKeyInfo DER)의 sha256 hex. PEM 줄바꿈이 달라도 같은 키면 같은 값 (openssl pkey -pubin -outform DER | sha256 과 같음) */
export function publicKeyFingerprint(pubKeyPath: string): string {
  if (isKmsKey(pubKeyPath)) throw new SignerError("PUBKEY_PIN_UNSUPPORTED", `KMS 키 주소는 여기서 지문을 계산할 수 없음: ${pubKeyPath}`);
  let pem: string;
  try {
    pem = readFileSync(pubKeyPath, "utf8");
  } catch {
    throw new SignerError("KEY_MISSING", `cosign 공개키 파일이 없음: ${pubKeyPath}`);
  }
  let der: Buffer;
  try {
    der = createPublicKey(pem).export({ type: "spki", format: "der" });
  } catch {
    throw new SignerError("PUBKEY_INVALID", `공개키 형식 오류: ${pubKeyPath}`);
  }
  return createHash("sha256").update(der).digest("hex");
}

const FINGERPRINT_RE = /^(?:sha256:)?([0-9a-fA-F]{64})$/;

/** 고정한 지문과 공개키가 같은지. 다르면 PUBKEY_MISMATCH. 같으면 지문 반환 */
export function checkPublicKeyPin(pubKeyPath: string, expected: string): string {
  const pinned = FINGERPRINT_RE.exec(expected.trim())?.[1]?.toLowerCase();
  if (!pinned) throw new SignerError("ARG_INVALID", `공개키 지문 형식 오류 (sha256 hex 64자): ${expected}`);
  const actual = publicKeyFingerprint(pubKeyPath);
  if (actual !== pinned) {
    throw new SignerError("PUBKEY_MISMATCH", `공개키가 고정한 지문과 다름 (고정 ${pinned.slice(0, 12)}…, 실제 ${actual.slice(0, 12)}…): ${pubKeyPath}`);
  }
  return actual;
}

/** 개인키 파일을 다른 사용자도 읽을 수 있으면 그 권한(8진수), 괜찮으면 undefined. KMS 주소·Windows 는 안 봄 */
export function looseKeyPermissions(keyPath: string): string | undefined {
  if (isKmsKey(keyPath) || process.platform === "win32") return undefined;
  let mode: number;
  try {
    mode = statSync(keyPath).mode;
  } catch {
    return undefined; // 없는 파일은 서명 때 KEY_MISSING
  }
  return (mode & 0o077) !== 0 ? (mode & 0o777).toString(8) : undefined;
}
