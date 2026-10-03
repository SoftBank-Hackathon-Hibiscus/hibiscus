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
  // PEM 블록이 하나뿐이어야 함. 여러 개면 Node 는 "PUBLIC KEY" 블록을, cosign(Go pem.Decode)은 첫 블록을 읽어서
  // 지문을 낸 키와 실제로 서명을 확인하는 키가 달라질 수 있음 (앞에 공격자 RSA PUBLIC KEY 블록을 끼워 넣기)
  const blocks = pem.match(/-----BEGIN [^-]+-----/g) ?? [];
  if (blocks.length !== 1 || blocks[0] !== "-----BEGIN PUBLIC KEY-----") {
    throw new SignerError("PUBKEY_INVALID", `공개키 파일에는 "PUBLIC KEY" PEM 블록 하나만 있어야 함 (지금 ${blocks.length}개${blocks.length > 0 ? `: ${blocks.join(", ")}` : ""}): ${pubKeyPath}`);
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
  return checkPublicKeyPins(pubKeyPath, [expected]);
}

/** 고정값 목록(sha256: 접두어·대문자 허용)을 소문자 hex 로. 형식이 틀리면 ARG_INVALID */
export function parsePins(expected: readonly string[], what: string): string[] {
  const pinned = expected.map((e) => {
    const hex = FINGERPRINT_RE.exec(e.trim())?.[1]?.toLowerCase();
    if (!hex) throw new SignerError("ARG_INVALID", `${what} 지문 형식 오류 (sha256 hex 64자): ${e}`);
    return hex;
  });
  if (pinned.length === 0) throw new SignerError("ARG_INVALID", `고정한 ${what} 지문이 없음`);
  return pinned;
}

/** 키 교체 중처럼 지문을 여러 개 고정했을 때. 공개키 지문이 그중 하나여야 함 */
export function checkPublicKeyPins(pubKeyPath: string, expected: readonly string[]): string {
  const pinned = parsePins(expected, "공개키");
  const actual = publicKeyFingerprint(pubKeyPath);
  if (!pinned.includes(actual)) {
    throw new SignerError("PUBKEY_MISMATCH", `공개키가 고정한 지문과 다름 (고정 ${pinned.map((p) => p.slice(0, 12) + "…").join(", ")} / 실제 ${actual.slice(0, 12)}…): ${pubKeyPath}`);
  }
  return actual;
}

/**
 * Rego 정책 파일 내용과 sha256. 고정값을 주면 그중 하나와 같아야 함 (POLICY_PIN_MISMATCH).
 * 레포 쓰기 권한자가 strict.rego 에 `tested { true }` 한 줄만 붙여도 정책이 무력해지는 것을 막음
 */
export function readPolicy(path: string, pins?: readonly string[]): { bytes: Buffer; sha256: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new SignerError("POLICY_MISSING", `Rego 정책 파일이 없음: ${path}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (pins !== undefined && pins.length > 0) {
    const pinned = parsePins(pins, "정책");
    if (!pinned.includes(sha256)) {
      throw new SignerError("POLICY_PIN_MISMATCH", `정책 파일이 고정한 지문과 다름 (고정 ${pinned.map((p) => p.slice(0, 12) + "…").join(", ")} / 실제 ${sha256.slice(0, 12)}…): ${path}`);
    }
  }
  return { bytes, sha256 };
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
