import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CosignSigner, CosignVerifier, isKmsKey } from "../src/cosign.js";
import { fakeCosign, REPO, tmp } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const KMS = "gcpkms://projects/hib/locations/asia-northeast3/keyRings/hibiscus/cryptoKeys/cosign";

describe("CosignSigner", () => {
  it("cosign sign --yes --key <키> -a 주석 <저장소>@<digest> 로 부르고 signature_ref 를 돌려줌", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin, argsFile } = fakeCosign(dir);

    const ref = await new CosignSigner(key, bin).sign(`${REPO}@${DIGEST}`, { run_id: "r-1", plan_hash: "b".repeat(64) });

    expect(ref).toBe(`cosign:${REPO}@${DIGEST}`);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "sign", "--yes", "--key", key, "-a", "run_id=r-1", "-a", `plan_hash=${"b".repeat(64)}`, `${REPO}@${DIGEST}`,
    ]);
  });

  it("noTlog 면 --use-signing-config=false --tlog-upload=false 를 붙임", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin, argsFile } = fakeCosign(dir);

    await new CosignSigner(key, bin, { noTlog: true }).sign(`${REPO}@${DIGEST}`, { run_id: "r-1" });

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "sign", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false", "-a", "run_id=r-1", `${REPO}@${DIGEST}`,
    ]);
  });

  it("cosign 이 실패하면 SIGN_FAILED (stderr 마지막 줄 포함)", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin } = fakeCosign(dir, { code: 1 });
    await expect(new CosignSigner(key, bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "SIGN_FAILED", message: /registry denied/ });
  });

  it("KMS 키 주소면 파일 확인 없이 --key 로 그대로 넘김 (비밀번호 불필요)", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await new CosignSigner(KMS, bin).sign(`${REPO}@${DIGEST}`, { run_id: "r-1" });
    expect(readFileSync(argsFile, "utf8").trim().split("\n").slice(0, 4)).toEqual(["sign", "--yes", "--key", KMS]);
  });

  it("키 파일이 없으면 cosign 을 부르지 않고 KEY_MISSING", async () => {
    const dir = tmp();
    const { bin } = fakeCosign(dir);
    await expect(new CosignSigner(join(dir, "nope.key"), bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "KEY_MISSING" });
  });
});

describe("CosignVerifier", () => {
  function pubKey(dir: string): string {
    const pub = join(dir, "cosign.pub");
    writeFileSync(pub, "dummy");
    return pub;
  }

  it("cosign verify --key <공개키> -a 주석 <저장소>@<digest> 로 부름", async () => {
    const dir = tmp();
    const pub = pubKey(dir);
    const { bin, argsFile } = fakeCosign(dir);

    await new CosignVerifier(pub, bin).verify(`${REPO}@${DIGEST}`, { run_id: "r-1", targets: "onprem+cloud_run" });

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "verify", "--key", pub, "-a", "run_id=r-1", "-a", "targets=onprem+cloud_run", `${REPO}@${DIGEST}`,
    ]);
  });

  it("noTlog 면 공개키 바로 뒤에 --insecure-ignore-tlog=true 를 붙임", async () => {
    const dir = tmp();
    const pub = pubKey(dir);
    const { bin, argsFile } = fakeCosign(dir);

    await new CosignVerifier(pub, bin, { noTlog: true }).verify(`${REPO}@${DIGEST}`, { run_id: "r-1" });

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "verify", "--key", pub, "--insecure-ignore-tlog=true", "-a", "run_id=r-1", `${REPO}@${DIGEST}`,
    ]);
  });

  it("cosign 이 실패하면 SIGNATURE_INVALID (stderr 마지막 줄 포함)", async () => {
    const dir = tmp();
    const { bin } = fakeCosign(dir, { code: 1, stderr: "Error: no matching attestations: missing or incorrect annotation" });
    await expect(new CosignVerifier(pubKey(dir), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
      message: /missing or incorrect annotation/,
    });
  });

  it.each([
    ["Error: no signatures found", "SIGNATURE_INVALID"],
    ["Error: no matching attestations: missing or incorrect annotation", "SIGNATURE_INVALID"],
    ["Error: not enough verified log entries from transparency log: 0 < 1", "SIGNATURE_INVALID"],
    ["Error: loading verifier from key opts: loading public key: new gcp kms client: credentials: could not find default credentials", "KEY_UNAVAILABLE"],
    ['Error: Get "https://localhost:5999/v2/": dial tcp [::1]:5999: connect: connection refused', "REGISTRY_UNAVAILABLE"],
    ["Error: GET https://asia-northeast3-docker.pkg.dev/v2/x/manifests/sha256:abc: DENIED: Permission denied", "REGISTRY_UNAVAILABLE"],
  ])("cosign stderr '%s' → %s (서명 문제만 검증 실패, 키·레지스트리 문제는 실행 오류)", async (stderr, code) => {
    const dir = tmp();
    const { bin } = fakeCosign(dir, { code: 1, stderr });
    await expect(new CosignVerifier(pubKey(dir), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code });
  });

  it("공개키 자리에 KMS 키 주소를 주면 파일 확인 없이 그대로 넘김", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await new CosignVerifier(KMS, bin).verify(`${REPO}@${DIGEST}`, {});
    expect(readFileSync(argsFile, "utf8").trim().split("\n").slice(0, 3)).toEqual(["verify", "--key", KMS]);
  });

  it.each([["gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k", true], ["awskms://alias/x", true], ["hashivault://cosign", true], ["/tmp/cosign.key", false], ["gcpkms://", false], ["file://cosign.key", false]])(
    "isKmsKey(%s) = %s",
    (key, kms) => {
      expect(isKmsKey(key)).toBe(kms);
    },
  );

  it("공개키 파일이 없으면 cosign 을 부르지 않고 KEY_MISSING", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await expect(new CosignVerifier(join(dir, "nope.pub"), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(() => readFileSync(argsFile)).toThrow();
  });

  it("cosign 실행 파일이 없으면 COSIGN_MISSING", async () => {
    const dir = tmp();
    await expect(new CosignVerifier(pubKey(dir), join(dir, "no-cosign")).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "COSIGN_MISSING" });
  });
});
