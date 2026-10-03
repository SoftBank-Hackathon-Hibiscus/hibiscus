import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorStatement, checkAnchors, runAnchor } from "../src/anchor.js";
import { appendAudit, checkAuditChain, GENESIS } from "../src/audit.js";
import { signLogLine } from "../src/io.js";
import { runAuditVerify } from "../src/verify.js";
import { NOW, RecordingSigner, tmp } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** 거절 줄 n개짜리 감사 로그. reason 을 바꾸면 같은 줄 수의 다른 체인이 됨 */
async function auditLog(path: string, n: number, reason: "policy_block" | "approval_missing" = "policy_block"): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await appendAudit(path, signLogLine({
      run_id: `r-${i}`, digest: DIGEST, plan_hash: "b".repeat(64), result: "refused",
      requester: "alice", approver: null, reason, signature_ref: null,
    }, NOW), undefined);
  }
}

function chain(path: string) {
  const c = checkAuditChain(readFileSync(path, "utf8"));
  if (!c.ok) throw new Error(`chain broken: ${c.reason}`);
  return c;
}

function setup() {
  const dir = tmp();
  return { dir, audit: join(dir, "sign_audit.jsonl"), anchors: join(dir, "anchors.jsonl"), signer: new RecordingSigner() };
}

describe("감사 로그 끝 고정 (anchor)", () => {
  it("지금 체인 끝(seq, hash)에 서명해서 anchors 파일에 한 줄 추가", async () => {
    const { audit, anchors, signer } = setup();
    await auditLog(audit, 2);
    const a = await runAnchor({ auditPath: audit, anchorsPath: anchors, signer, now: () => NOW });
    expect(a).toMatchObject({ kind: "audit_anchor", seq: 2, head: chain(audit).head, time: NOW.toISOString() });
    // 서명한 내용은 키 정렬 JSON 이라 같은 값이면 언제 다시 만들어도 같음
    expect(anchorStatement(a)).toBe(`{"head":"${a.head}","seq":2,"time":"${NOW.toISOString()}","type":"hibiscus-audit-anchor/v1"}`);
    expect(readFileSync(anchors, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("감사 로그가 없거나 비어 있으면 seq 0, head 는 처음 값", async () => {
    const { audit, anchors, signer } = setup();
    expect(await runAnchor({ auditPath: audit, anchorsPath: anchors, signer })).toMatchObject({ seq: 0, head: GENESIS });
    expect(await checkAnchors(anchors, { ok: true, lines: [], head: GENESIS }, signer)).toEqual({ ok: true, anchors: 1 });
  });

  it("다른 곳에 복사했다 되돌리며 끝 개행이 빠진 고정값 파일에도 새 줄을 따로 붙임", async () => {
    const { audit, anchors, signer } = setup();
    await auditLog(audit, 1);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    writeFileSync(anchors, readFileSync(anchors, "utf8").trimEnd());
    await auditLog(audit, 1);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    expect(await checkAnchors(anchors, chain(audit), signer)).toEqual({ ok: true, anchors: 2 });
  });

  it.each([
    ["끝을 잘라낸 로그", async (audit: string, _forged: string) => writeFileSync(audit, readFileSync(audit, "utf8").trim().split("\n").slice(0, 1).join("\n") + "\n"), /끝이 잘림/],
    ["처음부터 다시 쓴 로그", async (audit: string, forged: string) => {
      await auditLog(forged, 3, "approval_missing");
      writeFileSync(audit, readFileSync(forged, "utf8"));
    }, /다시 씀/],
  ])("이미 있는 고정값과 다른 로그(%s)는 다시 고정하지 않음 (ANCHOR_CONFLICT, 고정값 파일 그대로)", async (_name, tamper, detail) => {
    const { dir, audit, anchors, signer } = setup();
    await auditLog(audit, 3);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    const before = readFileSync(anchors, "utf8");
    await tamper(audit, join(dir, "forged.jsonl"));
    await expect(runAnchor({ auditPath: audit, anchorsPath: anchors, signer })).rejects.toMatchObject({ code: "ANCHOR_CONFLICT", message: expect.stringMatching(detail) });
    expect(readFileSync(anchors, "utf8")).toBe(before);
  });

  it("고정한 뒤 로그가 늘어나는 건 정상", async () => {
    const { audit, anchors, signer } = setup();
    await auditLog(audit, 2);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    await auditLog(audit, 3);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    expect(await checkAnchors(anchors, chain(audit), signer)).toEqual({ ok: true, anchors: 2 });
  });

  it("끝을 잘라내면 anchor_truncated (체인 자체는 멀쩡해서 audit 만으로는 못 잡던 것)", async () => {
    const { audit, anchors, signer } = setup();
    await auditLog(audit, 3);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    const lines = readFileSync(audit, "utf8").trim().split("\n");
    writeFileSync(audit, lines.slice(0, 2).join("\n") + "\n");
    expect(checkAuditChain(readFileSync(audit, "utf8")).ok).toBe(true);
    expect(await checkAnchors(anchors, chain(audit), signer)).toMatchObject({ ok: false, line: 3, reason: "anchor_truncated" });
  });

  it("체인을 통째로 다시 계산해 써도 anchor_mismatch", async () => {
    const { dir, audit, anchors, signer } = setup();
    await auditLog(audit, 3);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    const forged = join(dir, "forged.jsonl");
    await auditLog(forged, 3, "approval_missing");
    writeFileSync(audit, readFileSync(forged, "utf8"));
    expect(checkAuditChain(readFileSync(audit, "utf8")).ok).toBe(true);
    expect(await checkAnchors(anchors, chain(audit), signer)).toMatchObject({ ok: false, line: 3, reason: "anchor_mismatch" });
  });

  it("고정값의 head 까지 바꾸면 서명이 안 맞아서 anchor_signature_invalid", async () => {
    const { dir, audit, anchors, signer } = setup();
    await auditLog(audit, 3);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    const forged = join(dir, "forged.jsonl");
    await auditLog(forged, 3, "approval_missing");
    writeFileSync(audit, readFileSync(forged, "utf8"));
    const a = JSON.parse(readFileSync(anchors, "utf8"));
    writeFileSync(anchors, JSON.stringify({ ...a, head: chain(audit).head }) + "\n");
    expect(await checkAnchors(anchors, chain(audit), signer)).toMatchObject({ ok: false, reason: "anchor_signature_invalid" });
  });

  it.each([
    ["JSON 이 아님", "not json"],
    ["bundle 이 sigstore bundle 이 아님", JSON.stringify({ kind: "audit_anchor", seq: 0, head: GENESIS, time: "t", bundle: null })],
    ["모르는 필드", JSON.stringify({ kind: "audit_anchor", seq: 0, head: GENESIS, time: "t", bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }, extra: 1 })],
  ])("고정값 줄 형식이 틀리면 anchor_invalid (%s)", async (_name, line) => {
    const { anchors, signer } = setup();
    writeFileSync(anchors, line + "\n");
    expect(await checkAnchors(anchors, { ok: true, lines: [], head: GENESIS }, signer)).toMatchObject({ ok: false, reason: "anchor_invalid" });
  });

  it("고정값 파일이 비어 있으면 anchor_invalid, 없으면 실행 오류", async () => {
    const { anchors, signer } = setup();
    writeFileSync(anchors, "");
    expect(await checkAnchors(anchors, { ok: true, lines: [], head: GENESIS }, signer)).toMatchObject({ ok: false, reason: "anchor_invalid" });
    await expect(checkAnchors(join(tmp(), "none.jsonl"), { ok: true, lines: [], head: GENESIS }, signer)).rejects.toMatchObject({ code: "ANCHORS_MISSING" });
  });

  it("체인이 깨진 로그는 고정하지 않음 (anchors 파일도 안 만듦)", async () => {
    const { audit, anchors, signer } = setup();
    await auditLog(audit, 2);
    writeFileSync(audit, readFileSync(audit, "utf8").replace('"r-1"', '"r-9"'));
    await expect(runAnchor({ auditPath: audit, anchorsPath: anchors, signer })).rejects.toMatchObject({ code: "AUDIT_INVALID" });
    expect(existsSync(anchors)).toBe(false);
  });

  it("서명이 실패하면 anchors 파일에 아무것도 안 남김", async () => {
    const { audit, anchors } = setup();
    await auditLog(audit, 1);
    await expect(runAnchor({ auditPath: audit, anchorsPath: anchors, signer: new RecordingSigner(true) })).rejects.toThrow();
    expect(existsSync(anchors)).toBe(false);
  });

  it("audit 검사에 anchors 를 주면 체인 확인 뒤 고정값과도 맞춰 봄", async () => {
    const { audit, anchors, signer } = setup();
    await auditLog(audit, 3);
    await runAnchor({ auditPath: audit, anchorsPath: anchors, signer });
    expect(await runAuditVerify({ auditPath: audit, anchors: { path: anchors, verifier: signer } })).toMatchObject({ code: 0, lines: 3, anchors: 1 });
    const lines = readFileSync(audit, "utf8").trim().split("\n");
    writeFileSync(audit, lines.slice(0, 1).join("\n") + "\n");
    expect(await runAuditVerify({ auditPath: audit })).toMatchObject({ code: 0, lines: 1 });
    expect(await runAuditVerify({ auditPath: audit, anchors: { path: anchors, verifier: signer } })).toMatchObject({ code: 1, line: 3, reason: "anchor_truncated" });
  });
});
