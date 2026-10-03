import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { createApproval } from "../src/approval.js";
import { CONTRACTS, toJsonSchema } from "../src/contracts.js";
import { writeJson } from "../src/io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "../src/plan.js";
import { runSign } from "../src/sign.js";
import { copyPlan, NOW, plan, readJsonFile, readLog, RecordingSigner, REPO, tmp } from "./helpers.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = Object.fromEntries(CONTRACTS.map((c) => [c.name, ajv.compile(toJsonSchema(c))]));

function paths(dir: string) {
  return { outPath: join(dir, "sign_result.json"), logPath: join(dir, "decisions.jsonl") };
}

describe("runSign", () => {
  it("allow: 서명하고 sign_result.json, kind: sign 기록을 남김", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    const outcome = await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, now: () => NOW, ...paths(dir) });

    expect(outcome.code).toBe(0);
    const p = readJsonFile(plan("allow-onprem"));
    const result = readJsonFile(paths(dir).outPath);
    expect(result).toEqual({
      run_id: p.run_id,
      digest: p.digest,
      source_revision: p.source_revision,
      plan_hash: p.plan_hash,
      targets: p.targets,
      failover_allowed: p.failover_allowed,
      requester: "alice",
      approver: "auto",
      signature_ref: `cosign:${REPO}@${p.digest}`,
      signed_at: NOW.toISOString(),
    });
    expect(validators.SignResult!(result)).toBe(true);

    // 서명 대상은 <저장소>@digest, 주석에 sign_result 의 서명 대상 필드 전부 + plan 파일 해시
    expect(signer.calls).toEqual([
      {
        imageRef: `${REPO}@${p.digest}`,
        annotations: {
          run_id: p.run_id,
          plan_hash: p.plan_hash,
          source_revision: p.source_revision,
          targets: "onprem",
          failover_allowed: "false",
          requester: "alice",
          approver: "auto",
          plan_sha256: loadPlan(plan("allow-onprem")).planSha256,
        },
      },
    ]);

    const [line] = readLog(paths(dir).logPath);
    expect(line).toMatchObject({ kind: "sign", result: "signed", approver: "auto", reason: null, plan_hash: p.plan_hash });
    expect(validators.SignLog!(line)).toBe(true);
  });

  it("plan_hash 는 plan.json 값 그대로 (접두어 없음), digest 는 sha256: 형식", async () => {
    const dir = tmp();
    await runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer: new RecordingSigner(), now: () => NOW, ...paths(dir) });
    const result = readJsonFile(paths(dir).outPath);
    expect(result.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty("source_revision"); // plan 에 없으면 필드도 없음
  });

  it("block: 서명기를 부르지 않고, 예전 sign_result.json 도 지움", async () => {
    const dir = tmp();
    writeFileSync(paths(dir).outPath, '{"stale":true}');
    const signer = new RecordingSigner();
    const outcome = await runSign({ planPath: plan("block"), requester: "alice", imageRepo: REPO, signer, now: () => NOW, ...paths(dir) });

    expect(outcome).toMatchObject({ code: 1, reason: "policy_block" });
    expect(signer.calls).toHaveLength(0);
    expect(existsSync(paths(dir).outPath)).toBe(false);
    const [line] = readLog(paths(dir).logPath);
    expect(line).toMatchObject({ kind: "sign", result: "refused", reason: "policy_block", signature_ref: null, approver: null });
    expect(validators.SignLog!(line)).toBe(true);
  });

  it("needs_approval: 다른 사람 승인 기록이 있으면 서명", async () => {
    const dir = tmp();
    const approvalPath = join(dir, "approval.json");
    writeJson(approvalPath, createApproval(loadPlan(plan("needs-approval")), "alice", "bob", NOW));
    const signer = new RecordingSigner();
    const outcome = await runSign({ planPath: plan("needs-approval"), requester: "alice", approvalPath, imageRepo: REPO, signer, now: () => NOW, ...paths(dir) });

    expect(outcome.code).toBe(0);
    expect(readJsonFile(paths(dir).outPath)).toMatchObject({ requester: "alice", approver: "bob" });
    expect(signer.calls[0]?.annotations).toMatchObject({ requester: "alice", approver: "bob" });
  });

  it("needs_approval: 승인 뒤 targets 를 바꾸면 서명 안 함", async () => {
    const dir = tmp();
    const approvalPath = join(dir, "approval.json");
    writeJson(approvalPath, createApproval(loadPlan(plan("needs-approval")), "alice", "bob", NOW));
    // plan_hash 는 그대로 두고 targets 만 cloud_run 으로 바꿔치기
    const tampered = copyPlan(plan("needs-approval"), dir, { targets: ["cloud_run"] });
    const signer = new RecordingSigner();
    const outcome = await runSign({ planPath: tampered, requester: "alice", approvalPath, imageRepo: REPO, signer, now: () => NOW, ...paths(dir) });

    expect(outcome).toMatchObject({ code: 1, reason: "approval_mismatch" });
    expect(signer.calls).toHaveLength(0);
    expect(readLog(paths(dir).logPath)[0]).toMatchObject({ result: "refused", reason: "approval_mismatch", approver: "bob" });
  });

  it("needs_approval: 승인 유효시간이 지났으면 서명 안 하고 approval_expired 기록", async () => {
    const dir = tmp();
    const approvalPath = join(dir, "approval.json");
    writeJson(approvalPath, createApproval(loadPlan(plan("needs-approval")), "alice", "bob", NOW));
    const signer = new RecordingSigner();
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const outcome = await runSign({ planPath: plan("needs-approval"), requester: "alice", approvalPath, imageRepo: REPO, signer, approvalTtlMs: 15 * 60_000, now: () => later, ...paths(dir) });

    expect(outcome).toMatchObject({ code: 1, reason: "approval_expired" });
    expect(signer.calls).toHaveLength(0);
    const [line] = readLog(paths(dir).logPath);
    expect(line).toMatchObject({ result: "refused", reason: "approval_expired", approver: "bob" });
    expect(validators.SignLog!(line)).toBe(true);
  });

  it("needs_approval: 승인 기록이 없으면 서명 안 함", async () => {
    const dir = tmp();
    const outcome = await runSign({ planPath: plan("needs-approval"), requester: "alice", imageRepo: REPO, signer: new RecordingSigner(), now: () => NOW, ...paths(dir) });
    expect(outcome).toMatchObject({ code: 1, reason: "approval_missing" });
  });

  it("cosign 이 실패하면 code 2, sign_result.json 없음, refused(sign_failed) 기록", async () => {
    const dir = tmp();
    const outcome = await runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer: new RecordingSigner(true), now: () => NOW, ...paths(dir) });
    expect(outcome).toMatchObject({ code: 2, reason: "sign_failed" });
    expect(existsSync(paths(dir).outPath)).toBe(false);
    expect(readLog(paths(dir).logPath)[0]).toMatchObject({ result: "refused", reason: "sign_failed" });
  });

  it("plan 이 Plan 스키마와 다르면 오류 (서명·기록 모두 안 함)", async () => {
    const dir = tmp();
    const bad = copyPlan(plan("allow"), dir, { digest: "latest" });
    const signer = new RecordingSigner();
    await expect(runSign({ planPath: bad, requester: "alice", imageRepo: REPO, signer, ...paths(dir) })).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(signer.calls).toHaveLength(0);
    expect(existsSync(paths(dir).logPath)).toBe(false);
  });

  it("기본 Plan 스키마는 루트 contracts/ 공개본 (정책 폴더 원본과 같은 내용)", () => {
    expect(DEFAULT_PLAN_SCHEMA.replace(/\\/g, "/")).toMatch(/\/contracts\/Plan\.schema\.json$/);
    expect(DEFAULT_PLAN_SCHEMA).not.toMatch(/policy/);
    expect(readFileSync(DEFAULT_PLAN_SCHEMA, "utf8")).toBe(readFileSync(join(DEFAULT_PLAN_SCHEMA, "..", "..", "policy", "contracts", "Plan.schema.json"), "utf8"));
  });

  it("Plan 스키마를 못 읽으면 서명하지 않음 (D9)", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    await expect(
      runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, planSchemaPath: join(dir, "missing.schema.json"), ...paths(dir) }),
    ).rejects.toMatchObject({ code: "SCHEMA_UNAVAILABLE" });
    expect(signer.calls).toHaveLength(0);
  });

  it.each([["a%2Cb"], ["x".repeat(65)], ["bob(1)"], [""]])("요청자 id 형식이 틀리면(%s) 서명 전에 REQUESTER_INVALID, 서명·기록 모두 안 함", async (requester) => {
    const dir = tmp();
    const signer = new RecordingSigner();
    await expect(runSign({ planPath: plan("allow"), requester, imageRepo: REPO, signer, now: () => NOW, ...paths(dir) })).rejects.toMatchObject({ code: "REQUESTER_INVALID" });
    expect(signer.calls).toHaveLength(0);
    expect(existsSync(paths(dir).logPath)).toBe(false);
  });

  it("이미지 저장소에 태그가 붙어 있으면 오류", async () => {
    const dir = tmp();
    await expect(
      runSign({ planPath: plan("allow"), requester: "alice", imageRepo: `${REPO}:latest`, signer: new RecordingSigner(), ...paths(dir) }),
    ).rejects.toMatchObject({ code: "IMAGE_REPO_INVALID" });
  });
});
