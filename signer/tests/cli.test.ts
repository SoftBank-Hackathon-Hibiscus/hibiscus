import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
    env: { ...process.env, SIGNER_COSIGN_KEY: "", IMAGE_REPO: "", SIGNER_AUDIT_LOG: "", COSIGN_PUBLIC_KEY: "", SIGNER_PUBKEY_SHA256: "", SIGNER_POLICY_SHA256: "", SIGNER_AUDIT_ANCHORS: "", SIGNER_VERIFY_LATEST: "", SIGNER_AUDIT_SWEEP: "", ...env },
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

describe("cli 인자 파싱 오류", () => {
  it.each([
    ["모르는 옵션", ["--self-verfy"]],
    ["위치 인자", ["extra"]],
    ["- 로 시작하는 값", ["--requester", "-alice"]],
  ])("%s 로 끝나도 예전 sign_result.json 을 지우고 ARG_INVALID (2)", (_name, args) => {
    const dir = tmp();
    const out = join(dir, "sign_result.json");
    writeFileSync(out, '{"stale":true}');
    const r = cli(["sign", "--plan", plan("allow"), "--dry-run", "--out", out, ...args]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_INVALID/);
    expect(existsSync(out)).toBe(false);
  });
});

describe("cli 같이 써야 하는 옵션", () => {
  it("sign --test-result 를 --attest 없이 주면 ARG_INVALID (시험 결과는 증명서에만 들어감)", () => {
    const r = cli(["sign", "--plan", plan("allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--dry-run", "--test-result", "t.json", "--out", join(tmp(), "r.json"), "--log", join(tmp(), "d.jsonl")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_INVALID/);
  });

  it("verify --policy 를 --attestation 없이 주면 정책 검사를 건너뛰지 않고 ARG_INVALID (2), --json 이면 JSON", () => {
    const r = cli(["verify", "--result", join(tmp(), "none.json"), "--policy", "policy/strict.rego", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 2, error: "ARG_INVALID" });
  });

  it("audit --strict-images 를 --images 없이 주면 ARG_INVALID (2)", () => {
    const audit = join(tmp(), "a.jsonl");
    writeFileSync(audit, "");
    const r = cli(["audit", "--audit", audit, "--strict-images"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_INVALID/);
  });
});

describe("cli verify --json 은 실행 오류도 JSON", () => {
  /** version 과 verify 모두 성공하는 가짜 cosign 을 PATH 앞에 둠 */
  function okCosign(): string {
    const dir = tmp();
    writeFileSync(join(dir, "cosign"), `#!/bin/sh\nif [ "$1" = "version" ]; then echo '{"gitVersion":"v3.1.3"}'; exit 0; fi\necho '[]'\nexit 0\n`);
    chmodSync(join(dir, "cosign"), 0o755);
    return dir;
  }
  const RESULT = {
    run_id: "r-1", digest: `sha256:${"a".repeat(64)}`, plan_hash: "b".repeat(64), targets: ["onprem"], failover_allowed: false,
    requester: "alice", approver: "auto", signature_ref: `cosign:localhost:5001/hib/app@sha256:${"a".repeat(64)}`, signed_at: "2026-10-01T03:00:00.000Z",
  };

  it("다른 키로 통과했는데 두 번째 공개키 파일이 없으면 JSON 오류 한 줄 (stdout 이 비지 않음)", () => {
    const dir = tmp();
    const result = join(dir, "sr.json");
    writeFileSync(result, JSON.stringify(RESULT));
    const r = cli(["verify", "--result", result, "--pub", "keys/cosign.pub", "--pub", join(dir, "nwe.pub"), "--json"], { PATH: `${okCosign()}:${process.env.PATH}` });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 2, error: "KEY_MISSING" });
  });

  it("signed_at 에 짝 없는 서로게이트가 있어도 JSON (ANNOTATION_INVALID)", () => {
    const dir = tmp();
    const result = join(dir, "sr.json");
    writeFileSync(result, JSON.stringify(RESULT).replace("2026-10-01T03:00:00.000Z", "\\ud800"));
    const r = cli(["verify", "--result", result, "--json"], { PATH: `${okCosign()}:${process.env.PATH}` });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 2, error: "ANNOTATION_INVALID" });
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

describe("cli 여러 공개키", () => {
  it("fingerprint 는 --pub 를 여러 번 주면 키마다 한 줄", () => {
    const dir = tmp();
    const other = join(dir, "other.pub");
    writeFileSync(other, generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }));
    const r = cli(["fingerprint", "--pub", "keys/cosign.pub", "--pub", other]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(2);
  });

  it("COSIGN_PUBLIC_KEY 에 쉼표로 여러 개, 그중 하나가 고정 목록에 없으면 PUBKEY_MISMATCH", () => {
    const dir = tmp();
    const other = join(dir, "other.pub");
    writeFileSync(other, generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }));
    const r = cli(["fingerprint"], { COSIGN_PUBLIC_KEY: `keys/cosign.pub,${other}`, SIGNER_PUBKEY_SHA256: "2f049a775b1f1075c8c14ad13483b5d1ae411e32f7f89e2dc1b113b3a2d3dcfa" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/PUBKEY_MISMATCH/);
  });
});

describe("cli verify --json", () => {
  it("실행 오류도 JSON 한 줄 (code 2, error 코드)", () => {
    const r = cli(["verify", "--result", "/nope/sign_result.json", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, code: 2, error: "READ_FAILED" });
  });

  it("dry-run 결과는 JSON 으로 code 1, reason dry_run", () => {
    const dir = tmp();
    const result = join(dir, "sign_result.json");
    const signed = cli(["sign", "--plan", plan("allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--dry-run", "--out", result, "--log", join(dir, "d.jsonl")]);
    expect(signed.code).toBe(0);
    const r = cli(["verify", "--result", result, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: false, code: 1, reason: "dry_run" });
  });

  it("--max-age 가 숫자가 아니면 ARG_INVALID", () => {
    const r = cli(["verify", "--result", "x.json", "--max-age=abc", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ error: "ARG_INVALID" });
  });
});

describe("cli 개인키 권한", () => {
  it("다른 사용자도 읽을 수 있는 키면 SIGNER_STRICT_KEY_PERMS=1 일 때 서명 전에 멈춤 (KEY_PERMISSIONS)", () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    chmodSync(key, 0o644);
    const r = cli(["sign", "--plan", plan("allow"), "--requester", "alice", "--image-repo", "localhost:5001/hib/app", "--key", key, "--out", join(dir, "r.json"), "--log", join(dir, "d.jsonl")], { SIGNER_STRICT_KEY_PERMS: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/KEY_PERMISSIONS/);
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

  it("--json 이면 결과를 JSON 한 줄로, 실행 오류도 JSON", () => {
    const audit = auditLog(tmp());
    expect(JSON.parse(cli(["audit", "--audit", audit, "--json"]).stdout)).toMatchObject({ ok: true, code: 0, lines: 2, revoked: 0 });
    const r = cli(["audit", "--audit", join(tmp(), "none.jsonl"), "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 2, error: "AUDIT_INVALID" });
  });

  it.each([["--sweep"], ["--digests-file", "x.txt"], ["--sweep-max", "5"]])("%s 는 --images 없이 쓰면 ARG_INVALID (2)", (...flag) => {
    const r = cli(["audit", "--audit", auditLog(tmp()), ...flag]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_INVALID/);
  });

  it("--sweep-max 는 --sweep 없이 쓰면 ARG_INVALID (2)", () => {
    const r = cli(["audit", "--audit", auditLog(tmp()), "--images", "--image-repo", "localhost:5001/hib/app", "--sweep-max", "5", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "ARG_INVALID" });
  });
});

describe("cli verify --policy-sha256", () => {
  const RESULT = {
    run_id: "r-1", digest: `sha256:${"a".repeat(64)}`, plan_hash: "b".repeat(64), targets: ["onprem"], failover_allowed: false,
    requester: "alice", approver: "auto", signature_ref: `cosign:localhost:5001/hib/app@sha256:${"a".repeat(64)}`, signed_at: "2026-10-01T03:00:00.000Z",
  };
  /** 받은 인자와 --policy 파일 내용을 남기는 가짜 cosign. verify-attestation 은 증명서 없이 성공 */
  function recordingCosign(dir: string): string {
    writeFileSync(join(dir, "cosign"), `#!/bin/sh
if [ "$1" = "version" ]; then echo '{"gitVersion":"v3.1.3"}'; exit 0; fi
printf '%s\\n' "$@" >> "${dir}/args.txt"
prev=""; for a in "$@"; do [ "$prev" = "--policy" ] && cp "$a" "${dir}/seen.rego" && echo "$a" > "${dir}/policy-path.txt"; prev="$a"; done
if [ "$1" = "verify" ]; then echo '[]'; fi
exit 0
`);
    chmodSync(join(dir, "cosign"), 0o755);
    return dir;
  }

  function setup() {
    const dir = tmp();
    const result = join(dir, "sr.json");
    writeFileSync(result, JSON.stringify(RESULT));
    const policy = join(dir, "strict.rego");
    writeFileSync(policy, readFileSync(join(ROOT, "policy/strict.rego"), "utf8"));
    const pin = `sha256:${cli(["fingerprint", "--policy", policy]).stdout.split(" ")[0]!.slice("sha256:".length)}`;
    return { dir, result, policy, pin, env: { PATH: `${recordingCosign(dir)}:${process.env.PATH}` } };
  }

  it("fingerprint --policy 는 정책 파일 지문 한 줄", () => {
    const { policy, pin } = setup();
    expect(pin).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cli(["fingerprint", "--policy", policy, "--policy-sha256", pin]).stdout).toContain("(고정값에 있음)");
  });

  it("정책 파일이 고정값과 다르면 cosign 을 부르지 않고 POLICY_PIN_MISMATCH (2)", () => {
    const { dir, result, policy, pin, env } = setup();
    writeFileSync(policy, readFileSync(policy, "utf8") + "tested { true }\n");
    const r = cli(["verify", "--result", result, "--attestation", "--policy", policy, "--policy-sha256", pin, "--json"], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 2, error: "POLICY_PIN_MISMATCH" });
    expect(existsSync(join(dir, "args.txt"))).toBe(false);
  });

  it("고정값이 맞으면 확인한 바이트를 임시 파일로 넘기고, 끝나면 지움", () => {
    const { dir, result, policy, pin, env } = setup();
    const r = cli(["verify", "--result", result, "--attestation", "--policy", policy, "--policy-sha256", pin, "--json"], env);
    // 가짜 cosign 이 증명서를 안 돌려줘서 attestation_invalid 로 끝남. 정책 전달까지만 확인
    expect(JSON.parse(r.stdout)).toMatchObject({ code: 1, reason: "attestation_invalid" });
    const passed = readFileSync(join(dir, "policy-path.txt"), "utf8").trim();
    expect(passed).not.toBe(policy);
    expect(passed.endsWith(".rego")).toBe(true);
    expect(existsSync(passed)).toBe(false);
    expect(readFileSync(join(dir, "seen.rego"), "utf8")).toBe(readFileSync(policy, "utf8"));
  });

  it("SIGNER_POLICY_SHA256 도 같고, 빈 값은 꺼진 것으로 봄. --attestation 없이 플래그만 주면 ARG_INVALID", () => {
    const { result, policy, pin, env } = setup();
    writeFileSync(policy, readFileSync(policy, "utf8") + "# 바꿈\n");
    expect(JSON.parse(cli(["verify", "--result", result, "--attestation", "--policy", policy, "--json"], { ...env, SIGNER_POLICY_SHA256: pin }).stdout)).toMatchObject({ error: "POLICY_PIN_MISMATCH" });
    expect(JSON.parse(cli(["verify", "--result", result, "--attestation", "--policy", policy, "--json"], { ...env, SIGNER_POLICY_SHA256: "" }).stdout)).toMatchObject({ code: 1 });
    expect(JSON.parse(cli(["verify", "--result", result, "--policy-sha256", pin, "--json"], env).stdout)).toMatchObject({ error: "ARG_INVALID" });
  });
});

describe("cli --json 인자 파싱 오류", () => {
  it.each([
    ["verify 옵션 오타", ["verify", "--result", "x.json", "--json", "--polcy", "p.rego"]],
    ["verify 값 빠짐", ["verify", "--result", "x.json", "--json", "--max-age"]],
    ["audit 옵션 오타", ["audit", "--audit", "a.jsonl", "--json", "--image"]],
    ["reconcile 옵션 오타", ["reconcile", "--json", "--bogus"]],
  ])("%s 도 JSON 한 줄 (ARG_INVALID)", (_name, args) => {
    const r = cli(args);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 2, error: "ARG_INVALID" });
  });

  it("verify --anchors 를 --audit 없이 주면 ARG_INVALID, SIGNER_AUDIT_ANCHORS 만 켜져 있으면 무시", () => {
    const r = cli(["verify", "--result", join(tmp(), "none.json"), "--anchors", "a.jsonl", "--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "ARG_INVALID" });
    const env = cli(["verify", "--result", join(tmp(), "none.json"), "--json"], { SIGNER_AUDIT_ANCHORS: "a.jsonl" });
    expect(JSON.parse(env.stdout)).toMatchObject({ error: "READ_FAILED" });
  });
});

describe("cli revoke", () => {
  it("SIGNER_AUDIT_ANCHORS 가 켜져 있는데 --key 가 없으면 철회 줄을 쓰기 전에 ARG_MISSING", () => {
    const dir = tmp();
    const audit = join(dir, "a.jsonl");
    writeFileSync(audit, "");
    const r = cli(["revoke", "--audit", audit, "--digest", `sha256:${"c".repeat(64)}`, "--reason", "mistake", "--by", "carol"], { SIGNER_AUDIT_ANCHORS: join(dir, "anchors.jsonl") });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ARG_MISSING/);
    expect(readFileSync(audit, "utf8")).toBe("");
  });

  it("같은 철회를 두 번 해도 줄은 하나 (이미 철회돼 있음)", () => {
    const dir = tmp();
    const audit = join(dir, "a.jsonl");
    const args = ["revoke", "--audit", audit, "--digest", `sha256:${"c".repeat(64)}`, "--run-id", "r-1", "--reason", "mistake", "--by", "carol"];
    expect(cli(args).code).toBe(0);
    const again = cli(args);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("이미 철회돼 있음");
    expect(readFileSync(audit, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("cli 출력의 제어 문자", () => {
  it("sign_result 에 넣은 터미널 escape 를 그대로 찍지 않음 (\\u001b 로)", () => {
    const dir = tmp();
    const result = join(dir, "sr.json");
    writeFileSync(result, JSON.stringify({
      run_id: "r-1", digest: `sha256:${"a".repeat(64)}`, plan_hash: "b".repeat(64), targets: ["onprem"], failover_allowed: false,
      requester: "alice", approver: "auto", signature_ref: "cosign:\u001b[2J\u001b[32m[signer] 서명 확인함\u202e", signed_at: "2026-10-01T03:00:00.000Z",
    }));
    const r = cli(["verify", "--result", result]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("\u001b");
    expect(r.stderr).not.toContain("\u202e");
    expect(r.stderr).toContain("\\u001b[2J");
  });
});
