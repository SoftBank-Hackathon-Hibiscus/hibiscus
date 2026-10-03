import { generateKeyPairSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPublicKeyPin, checkPublicKeyPins, looseKeyPermissions, publicKeyFingerprint } from "../src/keys.js";
import { MultiKeyVerifier, type ImageVerifier } from "../src/cosign.js";
import { SignerError } from "../src/io.js";
import { DEFAULT_PUBLIC_KEY } from "../src/verify.js";
import { tmp } from "./helpers.js";

// openssl pkey -pubin -in keys/cosign.pub -outform DER | shasum -a 256 으로 따로 계산한 값
const TEAM_KEY = "2f049a775b1f1075c8c14ad13483b5d1ae411e32f7f89e2dc1b113b3a2d3dcfa";

function otherKey(dir: string): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const path = join(dir, "other.pub");
  writeFileSync(path, publicKey.export({ type: "spki", format: "pem" }));
  return path;
}

describe("공개키 지문", () => {
  it("레포 공개키 지문은 openssl 로 계산한 값과 같음", () => {
    expect(publicKeyFingerprint(DEFAULT_PUBLIC_KEY)).toBe(TEAM_KEY);
  });

  it("PEM 줄바꿈이 달라도 같은 키면 같은 지문", () => {
    const dir = tmp();
    const crlf = join(dir, "crlf.pub");
    writeFileSync(crlf, readFileSync(DEFAULT_PUBLIC_KEY, "utf8").replace(/\n/g, "\r\n"));
    expect(publicKeyFingerprint(crlf)).toBe(TEAM_KEY);
  });

  it.each([[TEAM_KEY], [`sha256:${TEAM_KEY}`], [TEAM_KEY.toUpperCase()]])("고정값 %s 과 같으면 통과", (pin) => {
    expect(checkPublicKeyPin(DEFAULT_PUBLIC_KEY, pin)).toBe(TEAM_KEY);
  });

  it("다른 공개키로 바꿔치기하면 PUBKEY_MISMATCH", () => {
    expect(() => checkPublicKeyPin(otherKey(tmp()), TEAM_KEY)).toThrow(expect.objectContaining({ code: "PUBKEY_MISMATCH" }));
  });

  it.each([
    ["지문 형식 오류", DEFAULT_PUBLIC_KEY, "abc", "ARG_INVALID"],
    ["공개키 파일 없음", "/nope/cosign.pub", TEAM_KEY, "KEY_MISSING"],
    ["KMS 키 주소", "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k", TEAM_KEY, "PUBKEY_PIN_UNSUPPORTED"],
  ])("%s → %s", (_, path, pin, code) => {
    expect(() => checkPublicKeyPin(path, pin)).toThrow(expect.objectContaining({ code }));
  });

  it("공개키가 아닌 파일이면 PUBKEY_INVALID", () => {
    const path = join(tmp(), "bad.pub");
    writeFileSync(path, "not a key");
    expect(() => publicKeyFingerprint(path)).toThrow(expect.objectContaining({ code: "PUBKEY_INVALID" }));
  });
});

describe.skipIf(process.platform === "win32")("개인키 파일 권한", () => {
  it.each([[0o600, undefined], [0o400, undefined], [0o640, "640"], [0o644, "644"], [0o604, "604"]])("권한 %o → %s", (mode, expected) => {
    const path = join(tmp(), "cosign.key");
    writeFileSync(path, "dummy");
    chmodSync(path, mode);
    expect(looseKeyPermissions(path)).toBe(expected);
  });

  it("KMS 키 주소와 없는 파일은 안 봄", () => {
    expect(looseKeyPermissions("gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k")).toBeUndefined();
    expect(looseKeyPermissions("/nope/cosign.key")).toBeUndefined();
  });
});

describe("키 교체: 지문 여러 개 고정", () => {
  it("공개키 지문이 고정 목록 중 하나면 통과, 없으면 PUBKEY_MISMATCH", () => {
    const dir = tmp();
    const other = otherKey(dir);
    const otherFp = publicKeyFingerprint(other);
    expect(checkPublicKeyPins(other, [TEAM_KEY, otherFp])).toBe(otherFp);
    expect(checkPublicKeyPins(DEFAULT_PUBLIC_KEY, [TEAM_KEY, otherFp])).toBe(TEAM_KEY);
    expect(() => checkPublicKeyPins(other, [TEAM_KEY])).toThrow(expect.objectContaining({ code: "PUBKEY_MISMATCH" }));
    expect(() => checkPublicKeyPins(other, [])).toThrow(expect.objectContaining({ code: "ARG_INVALID" }));
  });
});

describe("키 교체: 여러 공개키로 확인 (MultiKeyVerifier)", () => {
  const ok: ImageVerifier = { verify: async () => {}, signatures: async () => [{ k: "ok" }], attestations: async () => [{ s: "ok" }] };
  const invalid: ImageVerifier = {
    verify: async () => { throw new SignerError("SIGNATURE_INVALID", "다른 키"); },
    signatures: async () => [],
    attestations: async () => { throw new SignerError("SIGNATURE_INVALID", "증명서 없음"); },
  };
  const down: ImageVerifier = {
    verify: async () => { throw new SignerError("REGISTRY_UNAVAILABLE", "dial tcp"); },
    signatures: async () => { throw new SignerError("REGISTRY_UNAVAILABLE", "dial tcp"); },
    attestations: async () => { throw new SignerError("REGISTRY_UNAVAILABLE", "dial tcp"); },
  };
  const denied: ImageVerifier = { ...ok, attestations: async () => { throw new SignerError("POLICY_DENIED", "rego"); } };

  it("예전 키·새 키 중 하나로 확인되면 통과", async () => {
    await expect(new MultiKeyVerifier([invalid, ok]).verify("r", {})).resolves.toBeUndefined();
  });

  it("모든 키로 확인 실패면 SIGNATURE_INVALID", async () => {
    await expect(new MultiKeyVerifier([invalid, invalid]).verify("r", {})).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("어느 키로도 통과 못 했는데 설정 오류가 섞이면 그 오류를 그대로 (숨기지 않음)", async () => {
    await expect(new MultiKeyVerifier([invalid, down]).verify("r", {})).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" });
  });

  it("서명 목록·증명서는 키마다 모아서 돌려줌", async () => {
    expect(await new MultiKeyVerifier([ok, ok]).signatures("r")).toHaveLength(2);
    expect(await new MultiKeyVerifier([invalid, ok]).attestations("r", "t")).toEqual([{ s: "ok" }]);
  });

  it("믿는 키로 서명된 증명서가 정책을 어기면 다른 키 결과와 상관없이 POLICY_DENIED", async () => {
    await expect(new MultiKeyVerifier([ok, denied]).attestations("r", "t")).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
});
