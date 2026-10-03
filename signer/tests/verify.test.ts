import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeTargets, signAnnotations } from "../src/annotations.js";
import { createApproval } from "../src/approval.js";
import { CosignVerifier } from "../src/cosign.js";
import { writeJson } from "../src/io.js";
import { loadPlan } from "../src/plan.js";
import { runSign } from "../src/sign.js";
import { runAuditVerify, runVerify } from "../src/verify.js";
import { copyPlan, fakeCosign, NOW, plan, readJsonFile, RecordingSigner, REPO, tmp } from "./helpers.js";

const FIELDS = {
  run_id: "r-1",
  plan_hash: "b".repeat(64),
  targets: ["onprem"],
  failover_allowed: false,
  requester: "alice",
  approver: "auto",
  signed_at: "2026-10-01T03:00:00.000Z",
};

describe("signAnnotations", () => {
  it("sign_result 의 서명 대상 필드를 순서대로 주석으로 만듦", () => {
    expect(Object.entries(signAnnotations({ ...FIELDS, source_revision: "abc1234" }))).toEqual([
      ["run_id", "r-1"],
      ["plan_hash", "b".repeat(64)],
      ["source_revision", "abc1234"],
      ["targets", "onprem"],
      ["failover_allowed", "false"],
      ["requester", "alice"],
      ["approver", "auto"],
      ["signed_at", "2026-10-01T03%3A00%3A00.000Z"],
    ]);
  });

  it("source_revision 이 없으면 none, plan_sha256·audit_head 는 줄 때만 붙음", () => {
    expect(signAnnotations(FIELDS).source_revision).toBe("none");
    expect(signAnnotations(FIELDS)).not.toHaveProperty("plan_sha256");
    expect(signAnnotations(FIELDS, { planSha256: "c".repeat(64), auditHead: "d".repeat(64) })).toMatchObject({
      plan_sha256: "c".repeat(64),
      audit_head: "d".repeat(64),
    });
  });

  it.each([
    [["onprem", "cloud_run"], "onprem+cloud_run"],
    [["cloud_run", "onprem"], "cloud_run+onprem"],
    [["a,b"], "a%2Cb"],
    [["a+b"], "a%2Bb"],
    [['x="y"'], "x%3D%22y%22"],
  ])("targets %j → %s (쉼표·따옴표·= 가 cosign 에 그대로 가지 않음)", (targets, encoded) => {
    expect(encodeTargets(targets)).toBe(encoded);
    expect(signAnnotations({ ...FIELDS, targets }).targets).toBe(encoded);
  });

  it("인코딩할 수 없는 문자(짝 없는 서로게이트)는 ANNOTATION_INVALID", () => {
    expect(() => signAnnotations({ ...FIELDS, targets: ["\ud800"] })).toThrow(expect.objectContaining({ code: "ANNOTATION_INVALID" }));
  });

  it("['a','b'] 와 ['a+b'] 는 다르게 인코딩됨", () => {
    expect(encodeTargets(["a", "b"])).not.toBe(encodeTargets(["a+b"]));
  });
});

/** allow-onprem plan 을 가짜 레지스트리에 서명해 두고 sign_result 경로를 돌려줌 */
async function signed(dir: string, planPath = plan("allow-onprem")) {
  const signer = new RecordingSigner();
  const resultPath = join(dir, "sign_result.json");
  const outcome = await runSign({ planPath, requester: "alice", imageRepo: REPO, signer, outPath: resultPath, logPath: join(dir, "decisions.jsonl"), now: () => NOW });
  expect(outcome.code).toBe(0);
  return { signer, resultPath };
}

/** sign_result 를 일부 바꿔서 다른 파일로 저장 */
function tamper(resultPath: string, patch: Record<string, unknown>): string {
  const out = resultPath.replace(/\.json$/, ".tampered.json");
  writeFileSync(out, JSON.stringify({ ...readJsonFile(resultPath), ...patch }, null, 2));
  return out;
}

describe("runVerify", () => {
  it("서명한 sign_result 는 통과하고, 서명 주석 전부로 확인함", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const outcome = await runVerify({ resultPath, verifier: signer });

    expect(outcome.code).toBe(0);
    expect(signer.verifyCalls[0]?.annotations).toEqual({
      run_id: "r-003",
      plan_hash: readJsonFile(resultPath).plan_hash,
      source_revision: readJsonFile(resultPath).source_revision,
      targets: "onprem",
      failover_allowed: "false",
      requester: "alice",
      approver: "auto",
      approval_sha256: "none",
      signed_at: encodeURIComponent(NOW.toISOString()),
      image_repo: encodeURIComponent(REPO),
    });
  });

  it("--plan 을 주면 plan_sha256 까지 확인하고 통과", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const outcome = await runVerify({ resultPath, verifier: signer, planPath: plan("allow-onprem") });
    expect(outcome.code).toBe(0);
    expect(signer.verifyCalls[0]?.annotations.plan_sha256).toBe(loadPlan(plan("allow-onprem")).planSha256);
  });

  it.each([
    ["targets 에 cloud_run 끼워 넣기", { targets: ["onprem", "cloud_run"] }],
    ["targets 를 cloud_run 으로 교체", { targets: ["cloud_run"] }],
    ["failover_allowed 켜기", { failover_allowed: true }],
    ["approver 바꿔치기", { approver: "mallory" }],
    ["requester 바꿔치기", { requester: "mallory" }],
    ["plan_hash 바꾸기", { plan_hash: "f".repeat(64) }],
    ["run_id 바꾸기", { run_id: "r-999" }],
    ["signed_at 을 최근으로 고치기", { signed_at: "2026-10-03T09:00:00.000Z" }],
    ["source_revision 지우기", { source_revision: undefined }],
  ])("서명 뒤 %s → signature_invalid", async (_, patch) => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const outcome = await runVerify({ resultPath: tamper(resultPath, patch), verifier: signer });
    expect(outcome).toMatchObject({ code: 1, reason: "signature_invalid" });
  });

  it("digest 만 바꾸면 signature_ref 와 안 맞아서 ref_invalid", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const outcome = await runVerify({ resultPath: tamper(resultPath, { digest: `sha256:${"e".repeat(64)}` }), verifier: signer });
    expect(outcome).toMatchObject({ code: 1, reason: "ref_invalid" });
    expect(signer.verifyCalls).toHaveLength(0);
  });

  it("dry-run 결과는 cosign 을 부르지 않고 dry_run", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const r = readJsonFile(resultPath);
    const outcome = await runVerify({ resultPath: tamper(resultPath, { signature_ref: `dry-run:${REPO}@${r.digest}` }), verifier: signer });
    expect(outcome).toMatchObject({ code: 1, reason: "dry_run" });
    expect(signer.verifyCalls).toHaveLength(0);
  });

  it.each([["kms:whatever"], ["cosign:no-digest"], [`cosign:${REPO}:latest`]])("signature_ref 형식이 틀리면 ref_invalid (%s)", async (ref) => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const outcome = await runVerify({ resultPath: tamper(resultPath, { signature_ref: ref }), verifier: signer });
    expect(outcome).toMatchObject({ code: 1, reason: "ref_invalid" });
  });

  it("--image-repo 와 서명된 저장소가 다르면 repo_mismatch", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const outcome = await runVerify({ resultPath, verifier: signer, imageRepo: "asia-northeast3-docker.pkg.dev/hib-test/apps/other" });
    expect(outcome).toMatchObject({ code: 1, reason: "repo_mismatch" });
  });

  it("plan 의 targets 가 sign_result 와 다르면 plan_mismatch", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const other = copyPlan(plan("allow-onprem"), dir, { targets: ["onprem", "cloud_run"] });
    const outcome = await runVerify({ resultPath, verifier: signer, planPath: other });
    expect(outcome).toMatchObject({ code: 1, reason: "plan_mismatch", detail: expect.stringMatching(/targets/) });
  });

  it("plan 의 rules 만 바꿔도 plan_sha256 이 달라서 signature_invalid", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const other = copyPlan(plan("allow-onprem"), dir, { rules: [] });
    const outcome = await runVerify({ resultPath, verifier: signer, planPath: other });
    expect(outcome).toMatchObject({ code: 1, reason: "signature_invalid" });
  });

  it("sign_result 에 모르는 필드가 있으면 실행 오류 SIGN_RESULT_INVALID", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    await expect(runVerify({ resultPath: tamper(resultPath, { extra: 1 }), verifier: signer })).rejects.toMatchObject({ code: "SIGN_RESULT_INVALID" });
  });

  it("가짜 cosign: 바꾼 targets 값이 그대로 -a 로 넘어가서 서명과 안 맞음", async () => {
    const dir = tmp();
    const { resultPath } = await signed(dir);
    const r = readJsonFile(resultPath);
    const pub = join(dir, "cosign.pub");
    writeFileSync(pub, "dummy");
    const imageRef = `${REPO}@${r.digest}`;
    // 서명된 그대로의 인자일 때만 통과하는 cosign
    const expectArgs = ["verify", "--key", pub, ...Object.entries(signAnnotations(r, { approvalSha256: "none", imageRepo: REPO })).flatMap(([k, v]) => ["-a", `${k}=${v}`]), "--", imageRef];
    const { bin } = fakeCosign(dir, { expectArgs });
    const verifier = new CosignVerifier(pub, bin);

    expect(await runVerify({ resultPath, verifier })).toMatchObject({ code: 0 });

    const outcome = await runVerify({ resultPath: tamper(resultPath, { targets: ["onprem", "cloud_run"] }), verifier });
    expect(outcome).toMatchObject({ code: 1, reason: "signature_invalid" });
    expect(readFileSync(join(dir, "calls.txt"), "utf8")).toContain("targets=onprem+cloud_run");
  });

  describe("승인 기록 확인 (--approval)", () => {
    async function signedWithApproval(dir: string) {
      const signer = new RecordingSigner();
      const approvalPath = join(dir, "approval.json");
      writeJson(approvalPath, createApproval(loadPlan(plan("needs-approval")), "alice", "bob", NOW));
      const resultPath = join(dir, "sign_result.json");
      const outcome = await runSign({ planPath: plan("needs-approval"), requester: "alice", approvalPath, imageRepo: REPO, signer, outPath: resultPath, logPath: join(dir, "d.jsonl"), now: () => NOW });
      expect(outcome.code).toBe(0);
      return { signer, resultPath, approvalPath };
    }

    it("서명에 쓴 승인 기록이면 통과하고 approval_sha256 까지 확인", async () => {
      const { signer, resultPath, approvalPath } = await signedWithApproval(tmp());
      expect(await runVerify({ resultPath, verifier: signer, approvalPath })).toMatchObject({ code: 0 });
      expect(signer.verifyCalls[0]?.annotations.approval_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("승인 기록 없이 확인하면 승인 해시는 안 봄 (사람 승인 결과)", async () => {
      const { signer, resultPath } = await signedWithApproval(tmp());
      expect(await runVerify({ resultPath, verifier: signer })).toMatchObject({ code: 0 });
      expect(signer.verifyCalls[0]?.annotations).not.toHaveProperty("approval_sha256");
    });

    it("승인 시각만 고친 승인 기록이면 서명과 안 맞아서 signature_invalid", async () => {
      const dir = tmp();
      const { signer, resultPath, approvalPath } = await signedWithApproval(dir);
      const forged = join(dir, "forged.json");
      writeJson(forged, { ...readJsonFile(approvalPath), approved_at: "2026-10-03T09:00:00.000Z" });
      expect(await runVerify({ resultPath, verifier: signer, approvalPath: forged })).toMatchObject({ code: 1, reason: "signature_invalid" });
    });

    it("다른 승인자의 승인 기록이면 approval_mismatch", async () => {
      const dir = tmp();
      const { signer, resultPath } = await signedWithApproval(dir);
      const other = join(dir, "other.json");
      writeJson(other, createApproval(loadPlan(plan("needs-approval")), "alice", "carol", NOW));
      expect(await runVerify({ resultPath, verifier: signer, approvalPath: other })).toMatchObject({ code: 1, reason: "approval_mismatch", detail: expect.stringMatching(/approver/) });
    });

    it("자동 승인 결과에 승인 기록을 주면 approval_mismatch", async () => {
      const dir = tmp();
      const { signer, resultPath } = await signed(dir);
      const approvalPath = join(dir, "approval.json");
      writeJson(approvalPath, createApproval(loadPlan(plan("needs-approval")), "alice", "bob", NOW));
      expect(await runVerify({ resultPath, verifier: signer, approvalPath })).toMatchObject({ code: 1, reason: "approval_mismatch" });
    });
  });

  describe("서명 유효기간 (--max-age)", () => {
    const DAY = 24 * 60 * 60_000;
    it.each([
      ["서명 직후", 0, 0],
      ["23시간 뒤", 23 * 60 * 60_000, 0],
      ["25시간 뒤", 25 * 60 * 60_000, 1],
    ])("%s 면 code %i (유효 24시간)", async (_, ms, code) => {
      const { signer, resultPath } = await signed(tmp());
      const outcome = await runVerify({ resultPath, verifier: signer, maxAgeMs: DAY, now: () => new Date(NOW.getTime() + ms) });
      expect(outcome.code).toBe(code);
      if (code === 1) expect(outcome).toMatchObject({ reason: "expired" });
    });

    it("signed_at 이 미래면 expired", async () => {
      const { signer, resultPath } = await signed(tmp());
      expect(await runVerify({ resultPath, verifier: signer, maxAgeMs: DAY, now: () => new Date(NOW.getTime() - 5 * 60_000) })).toMatchObject({ code: 1, reason: "expired" });
    });
  });
});

describe("서명에 저장소 묶기 (image_repo)", () => {
  const OTHER = "asia-northeast3-docker.pkg.dev/hib-test/apps/other";

  it("이미지와 서명을 다른 저장소로 복사하고 signature_ref 만 고치면 repo_mismatch (두 저장소가 detail 에)", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const r = readJsonFile(resultPath);
    // 레지스트리 쓰기 권한자가 crane cp 로 서명까지 옮김
    signer.calls.push({ imageRef: `${OTHER}@${r.digest}`, annotations: { ...signer.calls[0]!.annotations } });
    const moved = tamper(resultPath, { signature_ref: `cosign:${OTHER}@${r.digest}` });
    expect(await runVerify({ resultPath: moved, verifier: signer, imageRepo: OTHER })).toMatchObject({
      code: 1,
      reason: "repo_mismatch",
      detail: expect.stringMatching(new RegExp(`${REPO}.*${OTHER}`)),
    });
  });

  it("image_repo 주석이 없는 예전 서명은 signature_invalid (다시 서명해야 함)", async () => {
    const dir = tmp();
    const { signer, resultPath } = await signed(dir);
    const { image_repo: _r, ...old } = signer.calls[0]!.annotations;
    signer.calls[0]!.annotations = old;
    expect(await runVerify({ resultPath, verifier: signer })).toMatchObject({ code: 1, reason: "signature_invalid" });
  });

  it("audit --images 를 옮겨 간 저장소로 돌리면 foreign_signature", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    const auditPath = join(dir, "sign_audit.jsonl");
    await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW });
    const c = signer.calls[0]!;
    signer.calls.push({ imageRef: c.imageRef.replace(REPO, OTHER), annotations: { ...c.annotations } });
    expect(await runAuditVerify({ auditPath, verifier: signer, imageRepo: OTHER })).toMatchObject({ code: 1, reason: "foreign_signature" });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0 });
  });
});
