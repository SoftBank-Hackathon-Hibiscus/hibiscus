import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { createApproval } from "../src/approval.js";
import { appendAudit, auditHash, checkAuditChain, GENESIS, readAuditHead } from "../src/audit.js";
import { CONTRACTS, toJsonSchema } from "../src/contracts.js";
import { DryRunSigner } from "../src/cosign.js";
import { signLogLine, writeJson } from "../src/io.js";
import { loadPlan } from "../src/plan.js";
import type { AuditLine, SignLog } from "../src/schema.js";
import { runSign } from "../src/sign.js";
import { runAuditVerify, runVerify } from "../src/verify.js";
import { copyPlan, NOW, plan, readLog, RecordingSigner, REPO, tmp } from "./helpers.js";

/** 이 테스트의 감사 로그는 서명 결정 줄만 씀 */
type SignLine = Omit<AuditLine, "entry"> & { entry: SignLog };

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateLine = ajv.compile(toJsonSchema(CONTRACTS.find((c) => c.name === "AuditLine")!));

const ENTRY = signLogLine(
  { run_id: "r-1", digest: `sha256:${"a".repeat(64)}`, plan_hash: "b".repeat(64), result: "refused", requester: "alice", approver: null, reason: "policy_block", signature_ref: null },
  NOW,
);

/**
 * 서명 4번으로 감사 로그 4줄을 만듦: 1 block 거절 / 2 allow-onprem 서명 / 3 승인 없음 거절 / 4 needs_approval 서명
 * signer 는 가짜 레지스트리 역할도 함
 */
async function chain(dir: string) {
  const signer = new RecordingSigner();
  const auditPath = join(dir, "sign_audit.jsonl");
  const logPath = join(dir, "decisions.jsonl");
  const approvalPath = join(dir, "approval.json");
  writeJson(approvalPath, createApproval(loadPlan(plan("needs-approval")), "alice", "bob", NOW));
  const sign = (name: Parameters<typeof plan>[0], outPath: string, approval?: string) =>
    runSign({ planPath: plan(name), requester: "alice", ...(approval ? { approvalPath: approval } : {}), imageRepo: REPO, signer, outPath, logPath, auditPath, now: () => NOW });

  expect((await sign("block", join(dir, "r1.json"))).code).toBe(1);
  expect((await sign("allow-onprem", join(dir, "r2.json"))).code).toBe(0);
  expect((await sign("needs-approval", join(dir, "r3.json"))).code).toBe(1);
  expect((await sign("needs-approval", join(dir, "r4.json"), approvalPath)).code).toBe(0);
  return { signer, auditPath, logPath, results: [join(dir, "r2.json"), join(dir, "r4.json")] as const };
}

const readLines = (path: string): SignLine[] => readLog(path);
const writeLines = (path: string, lines: unknown[]) => writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

/** 앞에서부터 hash 를 다시 계산 (체인을 통째로 고쳐 쓰는 공격). anchor 는 mode 대로 */
function recompute(lines: SignLine[], anchor: "keep" | "drop" | "remap"): SignLine[] {
  const renamed = new Map<string, string>([[GENESIS, GENESIS]]);
  let prev = GENESIS;
  return lines.map((l) => {
    const body = {
      seq: l.seq,
      prev_hash: prev,
      entry: l.entry,
      ...(l.anchor !== undefined && anchor === "keep" ? { anchor: l.anchor } : {}),
      ...(l.anchor !== undefined && anchor === "remap" ? { anchor: renamed.get(l.anchor) ?? l.anchor } : {}),
      // 기록한 주석의 audit_head 도 anchor 에 맞춰 같이 고침 (꼼꼼한 공격자)
      ...(l.annotations !== undefined && l.anchor !== undefined && anchor !== "drop"
        ? { annotations: { ...l.annotations, audit_head: anchor === "remap" ? (renamed.get(l.anchor) ?? l.anchor) : l.anchor } }
        : {}),
      ...(l.cancels !== undefined ? { cancels: renamed.get(l.cancels) ?? l.cancels } : {}),
    };
    const hash = auditHash(body);
    renamed.set(l.hash, hash);
    prev = hash;
    return { ...body, hash };
  });
}

describe("감사 로그 체인", () => {
  it("줄마다 seq·prev_hash 로 이어지고, hash 가 내용과 맞고, signed 줄에만 anchor 가 있음", async () => {
    const { auditPath } = await chain(tmp());
    const lines = readLines(auditPath);

    expect(lines.map((l) => [l.seq, l.entry.result, l.entry.reason])).toEqual([
      [1, "refused", "policy_block"],
      [2, "signed", null],
      [3, "refused", "approval_missing"],
      [4, "signed", null],
    ]);
    lines.forEach((l, i) => {
      expect(l.prev_hash).toBe(i === 0 ? GENESIS : lines[i - 1]!.hash);
      expect(l.hash).toBe(auditHash(l));
      expect(validateLine(l)).toBe(true);
      expect(l.anchor !== undefined).toBe(l.entry.result === "signed");
    });
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true, head: lines[3]!.hash });
  });

  it("감사 로그 줄의 entry 는 decisions.jsonl 의 kind: sign 줄과 같음", async () => {
    const { auditPath, logPath } = await chain(tmp());
    expect(readLines(auditPath).map((l) => l.entry)).toEqual(readLog(logPath));
  });

  it("서명 주석 audit_head 는 서명 직전 체인 끝이고, signed 줄 anchor 와 같음", async () => {
    const { signer, auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    expect(signer.calls.map((c) => c.annotations.audit_head)).toEqual([lines[0]!.hash, lines[2]!.hash]);
    expect([lines[1]!.anchor, lines[3]!.anchor]).toEqual([lines[0]!.hash, lines[2]!.hash]);
  });

  it("감사 로그가 없으면 체인 끝은 GENESIS 이고, 첫 서명의 audit_head 도 GENESIS", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    expect(await readAuditHead(auditPath)).toBe(GENESIS);
    const signer = new RecordingSigner();
    await runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW });
    expect(signer.calls[0]?.annotations.audit_head).toBe(GENESIS);
    expect(readLines(auditPath)[0]).toMatchObject({ seq: 1, prev_hash: GENESIS, anchor: GENESIS });
  });

  it("빈 파일은 줄 0개로 통과", () => {
    expect(checkAuditChain("")).toEqual({ ok: true, lines: [], head: GENESIS });
  });

  it.each([
    ["2번째 줄 requester 수정", (ls: SignLine[]) => { ls[1]!.entry.requester = "mallory"; return ls; }, 2, "hash_mismatch"],
    ["1번째(거절) 줄 수정하고 그 줄 hash 만 다시 계산", (ls: SignLine[]) => { ls[0]!.entry.requester = "mallory"; ls[0]!.hash = auditHash(ls[0]!); return ls; }, 2, "prev_mismatch"],
    // signed 줄은 기록한 서명 주석과도 안 맞아서 그 줄에서 바로 걸림
    ["2번째(signed) 줄 수정하고 그 줄 hash 만 다시 계산", (ls: SignLine[]) => { ls[1]!.entry.requester = "mallory"; ls[1]!.hash = auditHash(ls[1]!); return ls; }, 2, "annotations_invalid"],
    ["3번째 줄 삭제", (ls: SignLine[]) => ls.filter((_, i) => i !== 2), 3, "seq_gap"],
    ["2·3번째 줄 순서 바꿈", (ls: SignLine[]) => [ls[0], ls[2], ls[1], ls[3]], 2, "seq_gap"],
    ["1번째 줄 거절 기록 삭제하고 번호 다시 매김", (ls: SignLine[]) => ls.slice(1).map((l, i) => ({ ...l, seq: i + 1 })), 1, "prev_mismatch"],
  ] as const)("%s → %i번째 줄 %s", async (_, edit, line, reason) => {
    const { auditPath } = await chain(tmp());
    writeLines(auditPath, edit(readLines(auditPath)));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line, reason });
  });

  it("2번째 줄이 JSON 이 아니면 line_invalid", async () => {
    const { auditPath } = await chain(tmp());
    const raw = readFileSync(auditPath, "utf8").split("\n");
    raw[1] = "{broken";
    writeFileSync(auditPath, raw.join("\n"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 2, reason: "line_invalid" });
  });

  it("파일이 줄바꿈 없이 끝나면(쓰다 끊김·잘림) 마지막 줄 line_invalid", async () => {
    const { auditPath } = await chain(tmp());
    writeFileSync(auditPath, readFileSync(auditPath, "utf8").trimEnd());
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 4, reason: "line_invalid" });
  });

  it("거절 기록을 고치고 체인을 통째로 다시 계산 (anchor 그대로) → 2번째 줄 anchor_invalid", async () => {
    const { auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[0]!.entry.requester = "mallory";
    writeLines(auditPath, recompute(lines, "keep"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 2, reason: "anchor_invalid" });
  });

  it("anchor 를 지우고 체인을 다시 계산 → signed 줄에 anchor 없음 anchor_invalid", async () => {
    const { auditPath } = await chain(tmp());
    writeLines(auditPath, recompute(readLines(auditPath), "drop"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 2, reason: "anchor_invalid" });
  });

  it("refused 줄에 anchor 를 붙이면 anchor_invalid", async () => {
    const { auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    const body = { ...lines[0]!, anchor: GENESIS };
    lines[0] = { ...body, hash: auditHash(body) };
    writeLines(auditPath, recompute(lines, "keep"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 1, reason: "anchor_invalid" });
  });

  it("anchor 까지 맞춰 체인을 통째로 다시 계산하면 오프라인 검사는 통과하지만 이미지 서명과 안 맞음", async () => {
    const { signer, auditPath, results } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[0]!.entry.requester = "mallory";
    writeLines(auditPath, recompute(lines, "remap"));

    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 2, reason: "signature_invalid" });
    expect(await runVerify({ resultPath: results[0], verifier: signer, auditPath })).toMatchObject({ code: 1, reason: "signature_invalid" });
  });
});

describe("runAuditVerify", () => {
  it("정상 체인: 줄 수·체인 끝, --images 면 이미지 3개(거절 줄 digest 포함)의 서명과 맞춰 봄", async () => {
    const { signer, auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    expect(await runAuditVerify({ auditPath })).toEqual({ code: 0, lines: 4, head: lines[3]!.hash, signed: 0, images: 0, revoked: 0 });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toEqual({ code: 0, lines: 4, head: lines[3]!.hash, signed: 2, images: 3, revoked: 0 });
  });

  it("dry-run 서명 줄은 실제 서명이 없어서 맞춰 볼 서명 없이 통과 (저장소는 --image-repo)", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    await runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer: new DryRunSigner(), outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW });
    const verifier = new RecordingSigner();
    await expect(runAuditVerify({ auditPath, verifier })).rejects.toMatchObject({ code: "ARG_MISSING" });
    expect(await runAuditVerify({ auditPath, verifier, imageRepo: REPO })).toMatchObject({ code: 0, lines: 1, signed: 0, images: 1 });
  });

  it("signature_ref 를 옵션처럼 생긴 값(cosign:--help)으로 바꾸고 체인을 다시 계산 → ref_invalid", async () => {
    const { signer, auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[0]!.entry.requester = "mallory";
    lines[1]!.entry.signature_ref = "cosign:--help";
    lines[3]!.entry.signature_ref = "cosign:--help";
    writeLines(auditPath, recompute(lines, "remap"));
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 2, reason: "ref_invalid" });
  });

  it("signed 줄의 digest 를 바꾸고 체인을 다시 계산 → signature_ref 와 안 맞아 ref_invalid", async () => {
    const { signer, auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[3]!.entry.digest = `sha256:${"e".repeat(64)}`;
    writeLines(auditPath, recompute(lines, "remap"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 4, reason: "ref_invalid" });
  });

  /** signed 줄을 sign_failed 거절로 바꿔치기 (anchor·signature_ref 제거) */
  const downgrade = (l: SignLine): SignLine => {
    const { anchor: _anchor, annotations: _annotations, ...rest } = l;
    return { ...rest, entry: { ...l.entry, result: "refused", reason: "sign_failed", signature_ref: null } };
  };

  it("앞 줄을 고치고 뒤 signed 줄을 거절로 바꿔 체인을 다시 계산 → 레지스트리 서명이 로그에 없어서 unlogged_signature", async () => {
    const { signer, auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[0]!.entry.requester = "mallory";
    lines[3] = downgrade(lines[3]!);
    writeLines(auditPath, recompute(lines, "remap"));
    // 2번째 줄은 아직 signed 라 anchor 가 이미지 서명과 안 맞음
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 2, reason: "signature_invalid" });

    lines[1] = downgrade(lines[1]!);
    writeLines(auditPath, recompute(lines, "remap"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    // signed 줄이 하나도 없으면 저장소를 몰라서 --image-repo 필요
    await expect(runAuditVerify({ auditPath, verifier: signer })).rejects.toMatchObject({ code: "ARG_MISSING" });
    expect(await runAuditVerify({ auditPath, verifier: signer, imageRepo: REPO })).toMatchObject({ code: 1, reason: "unlogged_signature" });
  });

  it("signed 줄 하나만 거절로 바꿔도 같은 저장소의 다른 signed 줄로 찾아서 unlogged_signature", async () => {
    const { signer, auditPath } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[3] = downgrade(lines[3]!);
    writeLines(auditPath, recompute(lines, "remap"));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 4, reason: "unlogged_signature" });
  });

  it("마지막 signed 줄을 통째로 지워도 unlogged_signature", async () => {
    const { signer, auditPath } = await chain(tmp());
    writeLines(auditPath, readLines(auditPath).slice(0, 3));
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 1, line: 4, reason: "unlogged_signature" });
  });

  it("훔친 키로 signer 밖에서 audit_head 없이 서명: 기본은 넘기고 strictImages 면 unlogged_signature", async () => {
    const { signer, auditPath } = await chain(tmp());
    await signer.sign(signer.calls[0]!.imageRef, { run_id: "r-stolen", targets: "onprem+cloud_run" });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0 });
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true })).toMatchObject({
      code: 1,
      reason: "unlogged_signature",
      detail: expect.stringMatching(/audit_head 없음, run_id=r-stolen/),
    });
  });

  it("strictImages 여도 감사 로그대로 한 서명만 있으면 통과", async () => {
    const { signer, auditPath } = await chain(tmp());
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true })).toMatchObject({ code: 0 });
  });

  it("파일이 없으면 실행 오류 AUDIT_INVALID", async () => {
    await expect(runAuditVerify({ auditPath: join(tmp(), "nope.jsonl") })).rejects.toMatchObject({ code: "AUDIT_INVALID" });
  });
});

describe("runVerify --audit", () => {
  it("이 실행의 signed 줄 anchor 를 audit_head 로 넘겨서 확인", async () => {
    const { signer, auditPath, results } = await chain(tmp());
    const lines = readLines(auditPath);
    const outcome = await runVerify({ resultPath: results[1], verifier: signer, auditPath });
    expect(outcome).toMatchObject({ code: 0 });
    expect(signer.verifyCalls[0]?.annotations.audit_head).toBe(lines[3]!.anchor);
  });

  it("감사 로그에 이 서명 결과가 없으면 audit_mismatch", async () => {
    const dir = tmp();
    const { signer, results } = await chain(dir);
    const other = join(dir, "other.jsonl");
    writeFileSync(other, "");
    expect(await runVerify({ resultPath: results[0], verifier: signer, auditPath: other })).toMatchObject({ code: 1, reason: "audit_mismatch" });
  });

  it("감사 로그 체인이 끊겼으면 줄 번호와 함께 audit_mismatch", async () => {
    const { signer, auditPath, results } = await chain(tmp());
    const lines = readLines(auditPath);
    lines[2]!.entry.requester = "mallory";
    writeLines(auditPath, lines);
    expect(await runVerify({ resultPath: results[0], verifier: signer, auditPath })).toMatchObject({
      code: 1,
      reason: "audit_mismatch",
      detail: expect.stringMatching(/3번째 줄 \(hash_mismatch\)/),
    });
  });
});

describe("runSign 과 감사 로그", () => {
  it("감사 로그를 안 켜면 파일도 안 만들고 audit_head 주석도 없음", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    await runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), now: () => NOW });
    expect(signer.calls[0]?.annotations).not.toHaveProperty("audit_head");
    expect(existsSync(join(dir, "sign_audit.jsonl"))).toBe(false);
  });

  it("감사 로그 마지막 줄이 깨져 있으면 서명하지 않음 (AUDIT_INVALID)", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    writeFileSync(auditPath, "{broken\n");
    const signer = new RecordingSigner();
    await expect(
      runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW }),
    ).rejects.toMatchObject({ code: "AUDIT_INVALID" });
    expect(signer.calls).toHaveLength(0);
    expect(existsSync(join(dir, "r.json"))).toBe(false);
  });

  it.each([
    ["중간 줄 내용 수정", (ls: SignLine[]) => { ls[1]!.entry.requester = "mallory"; return ls; }, /2번째 줄 \(hash_mismatch\)/],
    ["중간 줄 삭제", (ls: SignLine[]) => ls.filter((_, i) => i !== 1), /2번째 줄 \(seq_gap\)/],
    ["체인 통째로 재계산(anchor 그대로)", (ls: SignLine[]) => { ls[0]!.entry.requester = "mallory"; return recompute(ls, "keep"); }, /2번째 줄 \(anchor_invalid\)/],
  ] as const)("감사 로그가 고쳐져 있으면(%s) 다음 서명은 cosign 을 부르기 전에 거부", async (_, edit, where) => {
    const dir = tmp();
    const { auditPath } = await chain(dir);
    writeLines(auditPath, edit(readLines(auditPath)));
    const signer = new RecordingSigner();
    await expect(
      runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "next.json"), logPath: join(dir, "next.jsonl"), auditPath, now: () => NOW }),
    ).rejects.toMatchObject({ code: "AUDIT_INVALID", message: expect.stringMatching(where) });
    expect(signer.calls).toHaveLength(0);
    expect(existsSync(join(dir, "next.json"))).toBe(false);
  });

  it("서명 뒤 감사 로그를 못 쓰면 sign_result 를 남기지 않고 signed 기록도 안 남김", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    const logPath = join(dir, "d.jsonl");
    // 서명하는 동안 누가 감사 로그를 망가뜨린 상황
    const signer = new (class extends RecordingSigner {
      override async sign(imageRef: string, annotations: Record<string, string>) {
        writeFileSync(auditPath, "{broken\n");
        return super.sign(imageRef, annotations);
      }
    })();
    await expect(
      runSign({ planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath, auditPath, now: () => NOW }),
    ).rejects.toMatchObject({ code: "AUDIT_INVALID" });
    expect(existsSync(join(dir, "r.json"))).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("결정 전에 멈춘 시도도 감사 로그에", () => {
  it.each([
    ["plan 형식 오류", { planPath: "BAD_PLAN" }, "PLAN_INVALID", false],
    ["요청자 id 형식 오류", { requester: "bob(1)" }, "REQUESTER_INVALID", false],
    ["태그 붙은 저장소", { imageRepo: `${REPO}:latest` }, "IMAGE_REPO_INVALID", true],
  ] as const)("%s → sign_error 줄 (%s), 체인은 그대로 이어짐", async (_, patch, code, hasRunId) => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    const badPlan = copyPlan(plan("allow"), dir, { digest: "latest" });
    const signer = new RecordingSigner();
    const o = { planPath: plan("allow"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW };
    const opts = { ...o, ...patch, ...("planPath" in patch ? { planPath: badPlan } : {}) };
    await expect(runSign(opts)).rejects.toMatchObject({ code });
    expect(signer.calls).toHaveLength(0);
    expect(existsSync(join(dir, "d.jsonl"))).toBe(false); // decisions.jsonl 계약은 그대로
    const [line] = readLog(auditPath) as AuditLine[];
    expect(line).toMatchObject({ seq: 1, entry: { kind: "sign_error", code, requester: opts.requester } });
    expect(line!.anchor).toBeUndefined();
    expect("run_id" in line!.entry).toBe(hasRunId);
    expect(validateLine(line)).toBe(true);

    // 다음 정상 서명은 그 뒤에 이어 쓰고, 체인 검사와 이미지 검사도 통과
    expect((await runSign(o)).code).toBe(0);
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runAuditVerify({ auditPath, verifier: signer })).toMatchObject({ code: 0, lines: 2, signed: 1 });
  });

  it("오류 줄에 anchor 를 붙여 고치면 anchor_invalid", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    await expect(runSign({ planPath: plan("allow"), requester: "bob(1)", imageRepo: REPO, signer: new RecordingSigner(), outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW })).rejects.toThrow();
    const [line] = readLog(auditPath) as AuditLine[];
    const body = { seq: line!.seq, prev_hash: line!.prev_hash, entry: line!.entry, anchor: GENESIS };
    writeFileSync(auditPath, JSON.stringify({ ...body, hash: auditHash(body) }) + "\n");
    expect(checkAuditChain(readFileSync(auditPath, "utf8"))).toMatchObject({ ok: false, line: 1, reason: "anchor_invalid" });
  });
});

describe("감사 로그 잠금", () => {
  it("다른 프로세스가 잠금을 잡고 있으면 기다리다가 AUDIT_LOCKED, 파일은 그대로", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    writeFileSync(`${auditPath}.lock`, "999");
    await expect(appendAudit(auditPath, ENTRY, undefined, { lockTimeoutMs: 100 })).rejects.toMatchObject({ code: "AUDIT_LOCKED" });
    expect(existsSync(auditPath)).toBe(false);
  });

  it("잠금이 풀리면 이어서 씀", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    writeFileSync(`${auditPath}.lock`, "999");
    setTimeout(() => rmSync(`${auditPath}.lock`), 100);
    await appendAudit(auditPath, ENTRY, undefined, { lockTimeoutMs: 2_000 });
    expect(readLines(auditPath)).toHaveLength(1);
  });

  it("오래된 잠금 파일(죽은 프로세스)은 지우고 씀", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    const lock = `${auditPath}.lock`;
    writeFileSync(lock, "999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await appendAudit(auditPath, ENTRY, undefined, { lockTimeoutMs: 100 });
    expect(readLines(auditPath)).toHaveLength(1);
  });

  it("쓰고 나면 잠금 파일이 남지 않음", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    await appendAudit(auditPath, ENTRY, undefined);
    await readAuditHead(auditPath);
    expect(existsSync(`${auditPath}.lock`)).toBe(false);
  });

  it("마지막 줄이 깨져 있으면 이어 쓰지 않음 (AUDIT_INVALID)", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    await appendAudit(auditPath, ENTRY, undefined);
    writeFileSync(auditPath, readFileSync(auditPath, "utf8").replace('"alice"', '"mallory"'));
    const before = readFileSync(auditPath, "utf8");
    await expect(appendAudit(auditPath, ENTRY, undefined)).rejects.toMatchObject({ code: "AUDIT_INVALID" });
    expect(readFileSync(auditPath, "utf8")).toBe(before);
  });

  it("여러 프로세스가 동시에 써도 체인이 갈라지지 않음", async () => {
    const dir = tmp();
    const auditPath = join(dir, "sign_audit.jsonl");
    const script = join(dir, "append.mts");
    const auditModule = fileURLToPath(new URL("../src/audit.ts", import.meta.url));
    const ioModule = fileURLToPath(new URL("../src/io.ts", import.meta.url));
    writeFileSync(
      script,
      `import { appendAudit } from ${JSON.stringify(auditModule)};
import { signLogLine } from ${JSON.stringify(ioModule)};
const entry = signLogLine(${JSON.stringify({ ...ENTRY, kind: undefined, time: undefined })}, new Date());
for (let i = 0; i < 10; i++) await appendAudit(${JSON.stringify(auditPath)}, entry, undefined, { lockTimeoutMs: 20_000 });
`,
    );
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const codes = await Promise.all(
      Array.from({ length: 4 }, () => new Promise<number | null>((done) => spawn(tsx, [script], { stdio: "inherit" }).on("exit", done))),
    );
    expect(codes).toEqual([0, 0, 0, 0]);
    const check = checkAuditChain(readFileSync(auditPath, "utf8"));
    expect(check).toMatchObject({ ok: true });
    expect(check.ok && check.lines.length).toBe(40);
  }, 30_000);
});
