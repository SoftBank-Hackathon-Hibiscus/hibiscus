import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CosignSigner, CosignVerifier } from "../src/cosign.js";
import { fakeCosign, REPO, tmp } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

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
    const { bin } = fakeCosign(dir, { code: 1 });
    await expect(new CosignVerifier(pubKey(dir), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
      message: /registry denied/,
    });
  });

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
