import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPROVAL_NAMESPACE, createApproval, readApproval, signApprovalFile, verifyApprovalSignature } from "../src/approval.js";
import { writeJson } from "../src/io.js";
import { loadPlan } from "../src/plan.js";
import { runSign } from "../src/sign.js";
import { runVerify } from "../src/verify.js";
import { NOW, plan, readLog, RecordingSigner, REPO, tmp } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const hasSshKeygen = spawnSync("ssh-keygen", ["-Y", "sign", "-?"]).error === undefined;

/** 승인자 bob·공격자 mallory SSH 키와 bob 만 적힌 승인자 명부 */
function people(dir: string) {
  const key = (name: string) => {
    const path = join(dir, name);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
    return path;
  };
  const bob = key("bob");
  const mallory = key("mallory");
  const allowed = join(dir, "allowed_signers");
  writeFileSync(allowed, `bob namespaces="${APPROVAL_NAMESPACE}" ${readFileSync(`${bob}.pub`, "utf8")}`);
  return { bob, mallory, allowed };
}

/** needs-approval plan 에 alice 요청, bob 승인 기록 */
function approvalFile(dir: string, approver = "bob") {
  const path = join(dir, "approval.json");
  writeJson(path, createApproval(loadPlan(plan("needs-approval")), "alice", approver, NOW));
  return path;
}

async function sign(dir: string, approvalPath: string, allowed: string) {
  const signer = new RecordingSigner();
  const outcome = await runSign({
    planPath: plan("needs-approval"), requester: "alice", approvalPath, imageRepo: REPO, signer,
    outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), now: () => NOW, approvers: { allowedSignersPath: allowed },
  });
  return { outcome, signer };
}

describe.skipIf(!hasSshKeygen)("승인자 SSH 서명", () => {
  it("bob 이 자기 키로 서명한 승인 기록만 받고, 서명한 키 지문을 서명 주석에 남김", async () => {
    const dir = tmp();
    const { bob, allowed } = people(dir);
    const approval = approvalFile(dir);
    expect(await signApprovalFile(approval, bob)).toBe(`${approval}.sig`);
    const { outcome, signer } = await sign(dir, approval, allowed);
    expect(outcome.code).toBe(0);
    const fingerprint = execFileSync("ssh-keygen", ["-l", "-f", `${bob}.pub`], { encoding: "utf8" }).split(" ")[1]!;
    expect(signer.calls[0]!.annotations.approval_key).toBe(encodeURIComponent(fingerprint));
  });

  it.each([
    ["서명 파일이 없음", async (_d: string, _p: ReturnType<typeof people>, _a: string) => {}, /서명 파일이 없음/],
    ["mallory 가 자기 키로 bob 이름 승인 기록에 서명", async (_d: string, p: ReturnType<typeof people>, a: string) => void (await signApprovalFile(a, p.mallory)), /bob\) 서명이 아님/],
    ["bob 서명 뒤 승인 시각을 고침", async (_d: string, p: ReturnType<typeof people>, a: string) => {
      await signApprovalFile(a, p.bob);
      writeFileSync(a, readFileSync(a, "utf8").replace(NOW.toISOString(), new Date(NOW.getTime() + 1000).toISOString()));
    }, /incorrect signature/],
    ["bob 의 git 커밋 서명(namespace 다름)을 가져다 붙임", async (_d: string, p: ReturnType<typeof people>, a: string) => {
      writeFileSync(`${a}.sig`, execFileSync("ssh-keygen", ["-Y", "sign", "-f", p.bob, "-n", "git"], { input: readFileSync(a), stdio: ["pipe", "pipe", "ignore"] }));
    }, /namespace/],
  ])("%s → approval_mismatch 로 서명 거절 (decisions·cosign 그대로)", async (_name, prepare, detail) => {
    const dir = tmp();
    const p = people(dir);
    const approval = approvalFile(dir);
    await prepare(dir, p, approval);
    const { outcome, signer } = await sign(dir, approval, p.allowed);
    expect(outcome).toMatchObject({ code: 1, reason: "approval_mismatch", detail: expect.stringMatching(detail) });
    expect(signer.calls).toHaveLength(0);
    expect(readLog(join(dir, "d.jsonl")).map((l) => l.reason)).toEqual(["approval_mismatch"]);
  });

  it("승인자 명부에 없는 사람(carol)이 자기 키로 서명해도 거절", async () => {
    const dir = tmp();
    const p = people(dir);
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "carol", "-f", join(dir, "carol")]);
    const approval = approvalFile(dir, "carol");
    await signApprovalFile(approval, join(dir, "carol"));
    expect((await sign(dir, approval, p.allowed)).outcome).toMatchObject({ code: 1, reason: "approval_mismatch" });
  });

  it("자동 승인(allow)은 승인자 서명이 필요 없음, 명부 파일이 없으면 실행 오류", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    const base = { requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), now: () => NOW };
    expect((await runSign({ ...base, planPath: plan("allow"), approvers: { allowedSignersPath: join(dir, "none") } })).code).toBe(0);
    const approval = approvalFile(dir);
    await expect(runSign({ ...base, planPath: plan("needs-approval"), approvalPath: approval, approvers: { allowedSignersPath: join(dir, "none") } })).rejects.toMatchObject({ code: "APPROVERS_MISSING" });
  });

  it("verify --approval --approvers: 승인 서명까지 확인하고, 서명 때 확인한 키(approval_key)와도 맞춰 봄", async () => {
    const dir = tmp();
    const p = people(dir);
    const approval = approvalFile(dir);
    await signApprovalFile(approval, p.bob);
    const { signer } = await sign(dir, approval, p.allowed);
    const resultPath = join(dir, "r.json");
    expect(await runVerify({ resultPath, verifier: signer, approvalPath: approval, approvers: { allowedSignersPath: p.allowed } })).toMatchObject({ code: 0 });
    // 서명은 그대로 두고 승인 서명만 mallory 것으로 바꾸면
    await signApprovalFile(approval, p.mallory);
    expect(await runVerify({ resultPath, verifier: signer, approvalPath: approval, approvers: { allowedSignersPath: p.allowed } })).toMatchObject({ code: 1, reason: "approval_mismatch" });
    await expect(runVerify({ resultPath, verifier: signer, approvers: { allowedSignersPath: p.allowed } })).rejects.toMatchObject({ code: "ARG_INVALID" });
  });

  it("readApproval·verifyApprovalSignature 는 같은 바이트로 확인 (확인 뒤 파일을 바꿔도 읽은 내용은 서명한 내용)", async () => {
    const dir = tmp();
    const p = people(dir);
    const approval = approvalFile(dir);
    await signApprovalFile(approval, p.bob);
    const { bytes } = readApproval(approval);
    writeFileSync(approval, "{}");
    expect(await verifyApprovalSignature(bytes, `${approval}.sig`, "bob", p.allowed)).toMatchObject({ ok: true, key: expect.stringMatching(/^SHA256:/) });
  });
});

describe.skipIf(!hasSshKeygen)("cli approve --ssh-key / sign --approvers", () => {
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(TSX, ["src/cli.ts", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SIGNER_AUDIT_LOG: "", SIGNER_APPROVERS: "", SIGNER_APPROVERS_SHA256: "", ...env } });

  it("approve --ssh-key 가 <승인 기록>.sig 를 만들고, sign --approvers --dry-run 이 받음. 명부 지문이 다르면 실행 오류", () => {
    const dir = tmp();
    const p = people(dir);
    const approval = join(dir, "approval.json");
    expect(cli(["approve", "--plan", plan("needs-approval"), "--requester", "alice", "--approver", "bob", "--out", approval, "--ssh-key", p.bob]).status).toBe(0);
    expect(existsSync(`${approval}.sig`)).toBe(true);
    const signArgs = ["sign", "--plan", plan("needs-approval"), "--requester", "alice", "--approval", approval, "--image-repo", "localhost:5001/hib/app", "--dry-run", "--out", join(dir, "r.json"), "--log", join(dir, "d.jsonl")];
    expect(cli([...signArgs, "--approvers", p.allowed]).status).toBe(0);
    // 환경변수로 줘도 같음, 명부를 고치면 지문 고정에서 멈춤
    const pin = cli(["fingerprint", "--approvers", p.allowed]).stdout.split(" ")[0]!;
    expect(cli(signArgs, { SIGNER_APPROVERS: p.allowed, SIGNER_APPROVERS_SHA256: pin }).status).toBe(0);
    writeFileSync(p.allowed, readFileSync(p.allowed, "utf8") + `mallory ${readFileSync(`${p.mallory}.pub`, "utf8")}`);
    const r = cli(signArgs, { SIGNER_APPROVERS: p.allowed, SIGNER_APPROVERS_SHA256: pin });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/APPROVERS_PIN_MISMATCH/);
  });
});
