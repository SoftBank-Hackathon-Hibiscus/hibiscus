import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmp } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

/** src/cli.ts 를 실제 프로세스로 실행 */
function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(TSX, ["src/cli.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, SIGNER_COSIGN_KEY: "", IMAGE_REPO: "", SIGNER_AUDIT_LOG: "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("cli sign", () => {
  it("인자가 빠져 실행 오류(2)로 끝나도 예전 sign_result.json 은 지움", () => {
    const dir = tmp();
    const out = join(dir, "sign_result.json");
    writeFileSync(out, '{"stale":true}');
    const r = cli(["sign", "--out", out]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_MISSING/);
    expect(existsSync(out)).toBe(false);
  });
});
