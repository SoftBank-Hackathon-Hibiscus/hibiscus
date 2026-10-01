import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CosignSigner } from "../src/cosign.js";
import { REPO, tmp } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** 받은 인자를 파일에 적고 code 로 끝나는 가짜 cosign */
function fakeCosign(dir: string, code = 0): { bin: string; argsFile: string } {
  const argsFile = join(dir, "args.txt");
  const bin = join(dir, "cosign");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho "boom: registry denied" >&2\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

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

  it("cosign 이 실패하면 SIGN_FAILED (stderr 마지막 줄 포함)", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin } = fakeCosign(dir, 1);
    await expect(new CosignSigner(key, bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "SIGN_FAILED", message: /registry denied/ });
  });

  it("키 파일이 없으면 cosign 을 부르지 않고 KEY_MISSING", async () => {
    const dir = tmp();
    const { bin } = fakeCosign(dir);
    await expect(new CosignSigner(join(dir, "nope.key"), bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "KEY_MISSING" });
  });
});
