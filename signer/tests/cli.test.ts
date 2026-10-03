import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { plan, tmp } from "./helpers.js";

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

describe("cli sign --approval-ttl", () => {
  it.each([["abc"], ["0"], ["-5"]])("%s 처럼 0 보다 큰 숫자가 아니면 실행 오류(2)", (ttl) => {
    const r = cli(["sign", "--plan", plan("allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--dry-run", `--approval-ttl=${ttl}`, "--out", join(tmp(), "r.json"), "--log", join(tmp(), "d.jsonl")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_INVALID/);
  });
});

describe("cli 빈 플래그", () => {
  it("--approval-ttl= 처럼 비워 두면 SIGNER_APPROVAL_TTL_MIN 을 씀", () => {
    const r = cli(["sign", "--plan", plan("allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--dry-run", "--approval-ttl=", "--out", join(tmp(), "r.json"), "--log", join(tmp(), "d.jsonl")], {
      SIGNER_APPROVAL_TTL_MIN: "abc",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_INVALID/);
  });
});

describe("cli fingerprint / 공개키 고정", () => {
  const TEAM_KEY = "2f049a775b1f1075c8c14ad13483b5d1ae411e32f7f89e2dc1b113b3a2d3dcfa";

  it("fingerprint 는 레포 공개키 지문을 출력", () => {
    const r = cli(["fingerprint"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`sha256:${TEAM_KEY}`);
  });

  it("고정한 지문과 다르면 verify 는 cosign 을 부르기 전에 PUBKEY_MISMATCH (2)", () => {
    const dir = tmp();
    const result = join(dir, "sign_result.json");
    writeFileSync(result, "{}");
    const r = cli(["verify", "--result", result, "--pubkey-sha256", "0".repeat(64)]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/PUBKEY_MISMATCH/);
  });

  it("SIGNER_SELF_VERIFY=1 인데 공개키가 고정값과 다르면 서명 전에 멈춤", () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const r = cli(["sign", "--plan", plan("allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--key", key, "--out", join(dir, "r.json"), "--log", join(dir, "d.jsonl")], {
      SIGNER_SELF_VERIFY: "1",
      SIGNER_PUBKEY_SHA256: "0".repeat(64),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/PUBKEY_MISMATCH/);
    expect(existsSync(join(dir, "d.jsonl"))).toBe(false);
  });
});

describe("cli audit", () => {
  /** dry-run 서명 2번으로 감사 로그 2줄 */
  function auditLog(dir: string): string {
    const audit = join(dir, "sign_audit.jsonl");
    for (const name of ["block", "allow"]) {
      cli(["sign", "--plan", plan(name as "block" | "allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--dry-run", "--out", join(dir, "r.json"), "--log", join(dir, "d.jsonl")], {
        SIGNER_AUDIT_LOG: audit,
      });
    }
    return audit;
  }

  it("체인이 이어져 있으면 0, 줄 수와 체인 끝 hash 출력", () => {
    const audit = auditLog(tmp());
    const r = cli(["audit", "--audit", audit]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/감사 로그 이상 없음: 2줄, head=[0-9a-f]{64}/);
  });

  it("한 줄을 고치면 1, 끊긴 줄 번호와 이유 출력", () => {
    const audit = auditLog(tmp());
    writeFileSync(audit, readFileSync(audit, "utf8").replace('"policy_block"', '"approval_missing"'));
    const r = cli(["audit", "--audit", audit]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/감사 로그 1번째 줄 문제 \(hash_mismatch\)/);
  });

  it("--audit 도 SIGNER_AUDIT_LOG 도 없으면 2", () => {
    expect(cli(["audit"]).code).toBe(2);
  });
});
