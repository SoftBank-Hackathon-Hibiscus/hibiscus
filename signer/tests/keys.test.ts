import { generateKeyPairSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPublicKeyPin, looseKeyPermissions, publicKeyFingerprint } from "../src/keys.js";
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
