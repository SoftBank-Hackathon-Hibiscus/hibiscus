import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditHash, checkAuditChain, GENESIS } from "../src/audit.js";
import type { ImageVerifier } from "../src/cosign.js";
import { SignerError, writeJson } from "../src/io.js";
import type { AuditLine } from "../src/schema.js";
import { runSign } from "../src/sign.js";
import { runAuditVerify, runVerify } from "../src/verify.js";
import { NOW, plan, readJsonFile, readLog, RecordingSigner, REPO, tmp } from "./helpers.js";

/** allow-onprem 한 번 서명. 감사 로그 1줄 */
async function signed(dir = tmp(), signer = new RecordingSigner()) {
  const auditPath = join(dir, "sign_audit.jsonl");
  const outPath = join(dir, "sign_result.json");
  const outcome = await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath, logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW });
  expect(outcome.code).toBe(0);
  return { dir, signer, auditPath, outPath };
}

const lines = (path: string): AuditLine[] => readLog(path);
const write = (path: string, ls: unknown[]) => writeFileSync(path, ls.map((l) => JSON.stringify(l)).join("\n") + "\n");
/** 한 줄 고치고 그 줄부터 hash 다시 계산 */
function rewrite(ls: AuditLine[]): AuditLine[] {
  let prev = GENESIS;
  return ls.map((l) => {
    const { hash: _hash, ...body } = { ...l, prev_hash: prev };
    const hash = auditHash(body);
    prev = hash;
    return { ...body, hash };
  });
}

describe("signed 줄에 서명 주석 전체 기록", () => {
  it("이미지 서명에 붙인 주석 그대로. 거절 줄에는 없음", async () => {
    const { signer, auditPath } = await signed();
    const [line] = lines(auditPath);
    expect(line!.annotations).toEqual(signer.calls[0]!.annotations);
    expect(line!.annotations!.targets).toBe("onprem");
  });

  it.each([
    ["거절 줄에 주석", (ls: AuditLine[]) => [{ ...ls[0]!, entry: { ...ls[0]!.entry, result: "refused", reason: "policy_block", signature_ref: null }, anchor: undefined }]],
    ["audit_head 가 anchor 와 다름", (ls: AuditLine[]) => [{ ...ls[0]!, annotations: { ...ls[0]!.annotations, audit_head: "f".repeat(64) } }]],
    ["requester 가 줄 내용과 다름", (ls: AuditLine[]) => [{ ...ls[0]!, annotations: { ...ls[0]!.annotations, requester: "mallory" } }]],
  ])("주석 기록이 줄 내용과 안 맞으면 annotations_invalid (%s)", async (_name, tamper) => {
    const { auditPath } = await signed();
    write(auditPath, rewrite(tamper(lines(auditPath)) as AuditLine[]));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 1, reason: "annotations_invalid" });
  });

  it("앞 줄부터 주석을 기록했는데 뒤 signed 줄 기록만 지우면 annotations_invalid", async () => {
    const { dir, signer, auditPath } = await signed();
    await signed(dir, signer);
    const ls = lines(auditPath);
    const { annotations: _a, ...stripped } = ls[1]!;
    write(auditPath, rewrite([ls[0]!, stripped as AuditLine]));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 2, reason: "annotations_invalid" });
  });

  it("주석 기록이 없는 예전 형식 줄은 그대로 통과 (예전 줄 hash 도 그대로)", async () => {
    const { signer, auditPath } = await signed();
    const { annotations: _a, ...old } = lines(auditPath)[0]!;
    write(auditPath, rewrite([old as AuditLine]));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0 });
  });
});

describe("쌍둥이 서명 (정상 서명 주석을 복사해서 일부만 바꿈)", () => {
  async function twin(change: Record<string, string>) {
    const s = await signed();
    const original = s.signer.calls[0]!;
    await s.signer.sign(original.imageRef, { ...original.annotations, ...change });
    return s;
  }

  it.each([
    ["targets·failover", { targets: "onprem+cloud_run", failover_allowed: "true" }, /targets onprem → onprem\+cloud_run/],
    ["approval_sha256", { approval_sha256: "a".repeat(64) }, /approval_sha256 none → a{64}/],
    ["주석 하나 더", { extra: "1" }, /\+extra=1/],
  ])("audit --images 가 twin_signature 로 잡음, --strict-images 없이도 (%s)", async (_name, change, detail) => {
    const { signer, auditPath } = await twin(change);
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 1, reason: "twin_signature", detail: expect.stringMatching(detail) });
  });

  it("audit_head 까지 뺀 쌍둥이는 signer 밖 서명과 같아서 --strict-images 일 때만 unlogged_signature, verify --audit 는 그래도 audit_mismatch", async () => {
    const { signer, auditPath, outPath } = await signed();
    const { audit_head: _h, ...copy } = signer.calls[0]!.annotations;
    await signer.sign(signer.calls[0]!.imageRef, { ...copy, targets: "onprem+cloud_run", failover_allowed: "true" });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0 });
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true })).toMatchObject({ code: 1, reason: "unlogged_signature" });
    writeJson(outPath, { ...readJsonFile(outPath), targets: ["onprem", "cloud_run"], failover_allowed: true });
    expect(await runVerify({ resultPath: outPath, verifier: signer, auditPath })).toMatchObject({ code: 1, reason: "audit_mismatch" });
  });

  it("쌍둥이에 맞춰 targets 를 고친 sign_result 는 verify --audit 에서 audit_mismatch", async () => {
    const { signer, auditPath, outPath } = await twin({ targets: "onprem+cloud_run", failover_allowed: "true" });
    writeJson(outPath, { ...readJsonFile(outPath), targets: ["onprem", "cloud_run"], failover_allowed: true });
    // 감사 로그 없이 하는 verify 는 쌍둥이 서명이 있어서 통과함 (한계)
    expect(await runVerify({ resultPath: outPath, verifier: signer })).toMatchObject({ code: 0 });
    expect(await runVerify({ resultPath: outPath, verifier: signer, auditPath })).toMatchObject({ code: 1, reason: "audit_mismatch", detail: expect.stringMatching(/targets/) });
  });

  it("정상 결과는 verify --audit 통과, cosign 에는 기록한 주석 전체를 넘김", async () => {
    const { signer, auditPath, outPath } = await signed();
    expect(await runVerify({ resultPath: outPath, verifier: signer, auditPath })).toMatchObject({ code: 0 });
    expect(signer.verifyCalls.at(-1)!.annotations).toEqual(signer.calls[0]!.annotations);
  });

  it("같은 실행을 정상적으로 두 번 서명한 로그는 통과 (줄마다 자기 서명)", async () => {
    const { dir, signer, auditPath } = await signed();
    await signed(dir, signer);
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0, signed: 2 });
  });
});

describe("서명 뒤 단계가 실패하면 signed 줄을 취소 줄로 닫음", () => {
  const flaky: ImageVerifier = {
    verify: async () => { throw new SignerError("SIGNATURE_INVALID", "일시 오류"); },
    signatures: async () => [],
  };

  it.each([
    ["자기 확인 실패", { selfVerifier: flaky }],
    ["증명서 실패", { attest: true, failAttest: true }],
  ])("%s: 감사 로그 signed + 취소 줄, decisions 는 거절 한 줄, audit --images 는 통과", async (_name, opts) => {
    const dir = tmp();
    const signer = new RecordingSigner();
    if ("failAttest" in opts) signer.attest = async () => { throw new Error("503"); };
    const auditPath = join(dir, "sign_audit.jsonl");
    const outcome = await runSign({
      planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW,
      ...("selfVerifier" in opts ? { selfVerifier: opts.selfVerifier } : {}),
      ...("attest" in opts ? { attest: true } : {}),
    });
    expect(outcome).toMatchObject({ code: 2, reason: "sign_failed" });
    const ls = lines(auditPath);
    expect(ls.map((l) => [l.entry.kind === "sign" && l.entry.result, l.cancels])).toEqual([["signed", undefined], ["refused", ls[0]!.hash]]);
    expect(readLog(join(dir, "d.jsonl")).map((l) => l.result)).toEqual(["refused"]);
    // 레지스트리에 남은 서명이 기록에 있어서 unlogged_signature 가 안 남 (예전엔 영구 경보)
    expect(await runAuditVerify({ auditPath, verifier: signer, imageRepo: REPO })).toMatchObject({ code: 0 });
  });

  it("믿는 키로 안 보이는 서명이라 취소된 줄은 맞는 서명이 없어도 됨 (다시 서명하면 audit --images 통과)", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    // 잘못된 키로 서명: 레지스트리에 올라가지만 믿는 키로는 안 보임
    const wrongKey = new RecordingSigner();
    const trusted = new RecordingSigner();
    const run = (signer: RecordingSigner, opts: object) =>
      runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW, ...opts });
    expect((await run(wrongKey, { selfVerifier: trusted })).code).toBe(2);
    expect(await runAuditVerify({ auditPath, verifier: trusted })).toMatchObject({ code: 0 });
    expect((await run(trusted, {})).code).toBe(0);
    expect(await runAuditVerify({ auditPath, verifier: trusted })).toMatchObject({ code: 0, signed: 2 });
  });

  it("취소된 서명의 주석으로 sign_result 를 다시 만들어도 verify --audit 에서 audit_mismatch", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    const auditPath = join(dir, "sign_audit.jsonl");
    await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, selfVerifier: flaky, now: () => NOW });
    const a = signer.calls[0]!.annotations;
    const rebuilt = join(dir, "rebuilt.json");
    writeJson(rebuilt, {
      run_id: a.run_id, digest: lines(auditPath)[0]!.entry.kind === "sign" ? (lines(auditPath)[0]!.entry as { digest: string }).digest : "", source_revision: a.source_revision,
      plan_hash: a.plan_hash, targets: ["onprem"], failover_allowed: false, requester: a.requester, approver: a.approver,
      signature_ref: `cosign:${signer.calls[0]!.imageRef}`, signed_at: decodeURIComponent(a.signed_at!),
    });
    expect(await runVerify({ resultPath: rebuilt, verifier: signer })).toMatchObject({ code: 0 });
    expect(await runVerify({ resultPath: rebuilt, verifier: signer, auditPath })).toMatchObject({ code: 1, reason: "audit_mismatch", detail: expect.stringMatching(/취소된 서명/) });
  });

  it.each([
    ["signed 줄에 cancels", (ls: AuditLine[]) => [{ ...ls[0]!, cancels: GENESIS }, ls[1]!]],
    ["sign_failed 아닌 거절 줄", (ls: AuditLine[]) => [ls[0]!, { ...ls[1]!, entry: { ...ls[1]!.entry, reason: "policy_block" } }]],
    ["없는 줄을 취소", (ls: AuditLine[]) => [ls[0]!, { ...ls[1]!, cancels: "e".repeat(64) }]],
    ["같은 줄을 두 번 취소", (ls: AuditLine[]) => [ls[0]!, ls[1]!, { ...ls[1]!, seq: 3 }]],
  ])("cancels 규칙을 어기면 cancel_invalid (%s)", async (_name, tamper) => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer: new RecordingSigner(), outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, selfVerifier: flaky, now: () => NOW });
    write(auditPath, rewrite(tamper(lines(auditPath)) as AuditLine[]));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, reason: "cancel_invalid" });
  });
});

describe("예전 형식(.sig) 서명", () => {
  /** cosign v3 처럼 새 형식이 있으면 기본 목록에 예전 형식을 안 넣는 가짜 레지스트리 */
  class TwoFormats extends RecordingSigner {
    legacy: Array<{ imageRef: string; annotations: Record<string, string> }> = [];
    override async signatures(imageRef: string, o: { legacy?: boolean } = {}): Promise<Array<Record<string, string>>> {
      const current = await super.signatures(imageRef);
      const old = this.legacy.filter((c) => c.imageRef === imageRef).map((c) => c.annotations);
      if (o.legacy === true) return old;
      return current.length > 0 ? current : old;
    }
  }

  it("새 형식 서명이 있는 이미지에 훔친 키로 붙인 예전 형식 서명도 --strict-images 면 봄", async () => {
    const signer = new TwoFormats();
    const { auditPath } = await signed(tmp(), signer);
    signer.legacy.push({ imageRef: signer.calls[0]!.imageRef, annotations: { run_id: "r-999", targets: "onprem+cloud_run" } });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0 });
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true })).toMatchObject({ code: 1, reason: "unlogged_signature", detail: expect.stringMatching(/r-999/) });
  });

  it("예전 형식만 있는 이미지는 두 번 세지 않음", async () => {
    const signer = new TwoFormats();
    const { auditPath } = await signed(tmp(), signer);
    // signer 서명을 예전 형식으로 옮김
    signer.legacy.push(...signer.calls.splice(0));
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true })).toMatchObject({ code: 0 });
  });
});
