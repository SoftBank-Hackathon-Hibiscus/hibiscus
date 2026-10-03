import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeTargets, encodeTargets } from "../src/annotations.js";
import { checkAnchors, runAnchor } from "../src/anchor.js";
import { auditHash, checkAuditChain } from "../src/audit.js";
import { runRevoke } from "../src/revoke.js";
import { runSign } from "../src/sign.js";
import { runAuditVerify, runVerify } from "../src/verify.js";
import { copyPlan, NOW, plan, readJsonFile, readLog, RecordingSigner, REPO, tmp } from "./helpers.js";

const LATER = new Date(NOW.getTime() + 60_000);

/** 같은 감사 로그·레지스트리에 여러 번 서명 */
function pipeline() {
  const dir = tmp();
  const signer = new RecordingSigner();
  const auditPath = join(dir, "sign_audit.jsonl");
  let n = 0;
  const sign = async (planPath: string, o: { repo?: string; at?: Date } = {}) => {
    const outPath = join(dir, `r${++n}.json`);
    const outcome = await runSign({ planPath, requester: "alice", imageRepo: o.repo ?? REPO, signer, outPath, logPath: join(dir, "d.jsonl"), auditPath, now: () => o.at ?? NOW });
    return { outcome, outPath };
  };
  /** allow-onprem plan 을 run_id·digest·targets 만 바꿔서 */
  const planOf = (runId: string, digestChar: string, patch: Record<string, unknown> = {}) => {
    const d = join(dir, `p-${runId}`);
    mkdirSync(d, { recursive: true });
    return copyPlan(plan("allow-onprem"), d, { run_id: runId, digest: `sha256:${digestChar.repeat(64)}`, ...patch });
  };
  return { dir, signer, auditPath, sign, planOf };
}

describe("decodeTargets", () => {
  it.each([[["onprem"]], [["onprem", "cloud_run"]], [["a+b", "50%"]], [[]]])("encodeTargets 의 반대 (%j)", (targets) => {
    expect(decodeTargets(encodeTargets(targets))).toEqual(targets);
  });
});

describe("signer revoke", () => {
  it("감사 로그 체인에 철회 줄을 이어 붙이고, 그 서명은 verify --audit 에서 revoked", async () => {
    const p = pipeline();
    const { outPath } = await p.sign(plan("allow-onprem"));
    const digest = readJsonFile(outPath).digest;
    const { line, signed } = await runRevoke({ auditPath: p.auditPath, digest, reason: "vulnerability", by: "carol", note: "CVE-2026-0001", now: () => LATER });
    expect(signed).toBe(1);
    expect(line).toMatchObject({ seq: 2, entry: { kind: "revoke", digest, reason: "vulnerability", by: "carol" } });
    expect(checkAuditChain(readFileSync(p.auditPath, "utf8"))).toMatchObject({ ok: true });
    expect(await runVerify({ resultPath: outPath, verifier: p.signer, auditPath: p.auditPath })).toMatchObject({
      code: 1, reason: "revoked", detail: expect.stringMatching(/2번째 줄.*vulnerability, carol: CVE-2026-0001/),
    });
    // 감사 로그 없이 하는 verify 는 철회를 모름 (한계)
    expect(await runVerify({ resultPath: outPath, verifier: p.signer })).toMatchObject({ code: 0 });
    expect(await runAuditVerify({ auditPath: p.auditPath, verifier: p.signer })).toMatchObject({ code: 0, revoked: 1 });
  });

  it("run_id 만 철회하면 그 실행만 revoked, 같은 이미지의 다른 실행은 통과", async () => {
    const p = pipeline();
    const first = await p.sign(p.planOf("r-1", "c"));
    const second = await p.sign(p.planOf("r-2", "c"));
    await runRevoke({ auditPath: p.auditPath, digest: `sha256:${"c".repeat(64)}`, runId: "r-1", reason: "mistake", by: "carol" });
    expect(await runVerify({ resultPath: first.outPath, verifier: p.signer, auditPath: p.auditPath })).toMatchObject({ code: 1, reason: "revoked" });
    expect(await runVerify({ resultPath: second.outPath, verifier: p.signer, auditPath: p.auditPath })).toMatchObject({ code: 0 });
  });

  it("이미지 전체를 철회하면 다시 서명하지 않음 (DIGEST_REVOKED, 결정 전 오류로 감사 로그에 남김)", async () => {
    const p = pipeline();
    await runRevoke({ auditPath: p.auditPath, digest: `sha256:${"c".repeat(64)}`, reason: "key_compromise", by: "carol" });
    await expect(p.sign(p.planOf("r-1", "c"))).rejects.toMatchObject({ code: "DIGEST_REVOKED" });
    expect(p.signer.calls).toHaveLength(0);
    expect(readLog(p.auditPath).map((l) => l.entry.kind)).toEqual(["revoke", "sign_error"]);
    // run 하나만 철회했으면 새 실행으로 서명 가능
    await runRevoke({ auditPath: p.auditPath, digest: `sha256:${"d".repeat(64)}`, runId: "r-0", reason: "mistake", by: "carol" });
    expect((await p.sign(p.planOf("r-2", "d"))).outcome.code).toBe(0);
  });

  it("이 실행만 철회(미리 철회 포함)한 것도 다시 서명하지 않음 (RUN_REVOKED), 같은 철회를 다시 하면 줄이 안 쌓임", async () => {
    const p = pipeline();
    const digest = `sha256:${"c".repeat(64)}`;
    const first = await runRevoke({ auditPath: p.auditPath, digest, runId: "r-1", reason: "mistake", by: "carol" });
    const again = await runRevoke({ auditPath: p.auditPath, digest, runId: "r-1", reason: "mistake", by: "carol" });
    expect([first.existing, again.existing, again.line.seq]).toEqual([false, true, first.line.seq]);
    await expect(p.sign(p.planOf("r-1", "c"))).rejects.toMatchObject({ code: "RUN_REVOKED" });
    expect(p.signer.calls).toHaveLength(0);
    expect((await p.sign(p.planOf("r-2", "c"))).outcome.code).toBe(0);
  });

  it("verify --audit --anchors: 로그 끝의 철회 줄을 잘라낸 로그는 끝 고정값과 달라서 audit_mismatch (anchors 없으면 통과하는 약점)", async () => {
    const p = pipeline();
    const { outPath } = await p.sign(plan("allow-onprem"));
    await runRevoke({ auditPath: p.auditPath, digest: readJsonFile(outPath).digest, reason: "vulnerability", by: "carol" });
    const anchors = join(p.dir, "anchors.jsonl");
    await runAnchor({ auditPath: p.auditPath, anchorsPath: anchors, signer: p.signer });
    writeFileSync(p.auditPath, readFileSync(p.auditPath, "utf8").trim().split("\n")[0] + "\n");
    expect(await runVerify({ resultPath: outPath, verifier: p.signer, auditPath: p.auditPath })).toMatchObject({ code: 0 });
    expect(await runVerify({ resultPath: outPath, verifier: p.signer, auditPath: p.auditPath, anchors: { path: anchors, verifier: p.signer } })).toMatchObject({
      code: 1, reason: "audit_mismatch", detail: expect.stringMatching(/anchor_truncated/),
    });
    await expect(runVerify({ resultPath: outPath, verifier: p.signer, anchors: { path: anchors, verifier: p.signer } })).rejects.toMatchObject({ code: "ARG_INVALID" });
  });

  it.each([
    ["digest 형식", { digest: "sha256:abc" }],
    ["reason", { reason: "because" }],
    ["by 형식", { by: "carol smith" }],
    ["note 길이", { note: "x".repeat(201) }],
  ])("철회 기록 형식이 틀리면 ARG_INVALID (%s), 감사 로그는 그대로", async (_name, patch) => {
    const p = pipeline();
    await p.sign(plan("allow-onprem"));
    const before = readFileSync(p.auditPath, "utf8");
    await expect(runRevoke({ auditPath: p.auditPath, digest: `sha256:${"c".repeat(64)}`, reason: "mistake", by: "carol", ...patch })).rejects.toMatchObject({ code: "ARG_INVALID" });
    expect(readFileSync(p.auditPath, "utf8")).toBe(before);
  });

  it("철회 줄에 anchor 를 붙이면 anchor_invalid, 철회 줄을 잘라내면 끝 고정값에서 anchor_truncated", async () => {
    const p = pipeline();
    await p.sign(plan("allow-onprem"));
    await runRevoke({ auditPath: p.auditPath, digest: `sha256:${"c".repeat(64)}`, reason: "mistake", by: "carol" });
    const anchors = join(p.dir, "anchors.jsonl");
    await runAnchor({ auditPath: p.auditPath, anchorsPath: anchors, signer: p.signer });
    const lines = readFileSync(p.auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));

    const withAnchor = { ...lines[1], anchor: lines[0].hash };
    const forged = join(p.dir, "forged.jsonl");
    writeFileSync(forged, [lines[0], { ...withAnchor, hash: auditHash(withAnchor) }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(checkAuditChain(readFileSync(forged, "utf8"))).toMatchObject({ ok: false, line: 2, reason: "anchor_invalid" });

    writeFileSync(p.auditPath, JSON.stringify(lines[0]) + "\n");
    const chain = checkAuditChain(readFileSync(p.auditPath, "utf8"));
    if (!chain.ok) throw new Error("chain");
    expect(await checkAnchors(anchors, chain, p.signer)).toMatchObject({ ok: false, reason: "anchor_truncated" });
  });
});

describe("verify --latest (예전 결과 재사용·롤백)", () => {
  it("--audit 없이 쓰면 ARG_MISSING", async () => {
    const p = pipeline();
    const { outPath } = await p.sign(plan("allow-onprem"));
    await expect(runVerify({ resultPath: outPath, verifier: p.signer, latest: true })).rejects.toMatchObject({ code: "ARG_MISSING" });
  });

  it.each([
    ["뒤에 같은 저장소·같은 위치로 새 이미지 서명", { digest: "d" }, "superseded"],
    ["뒤 서명은 배포 위치가 안 겹침 (cloud_run 만)", { digest: "d", patch: { targets: ["cloud_run"] } }, "ok"],
    ["뒤 서명은 다른 저장소", { digest: "d", repo: "asia-northeast3-docker.pkg.dev/hib-test/apps/other" }, "ok"],
    ["뒤 서명이 철회됨", { digest: "d", revoke: true }, "ok"],
    ["같은 이미지가 뒤에서 block", { block: true }, "superseded"],
  ])("%s → %s", async (_name, later, expected) => {
    const p = pipeline();
    const first = await p.sign(p.planOf("r-1", "c"));
    if ("block" in later) {
      await p.sign(p.planOf("r-2", "c", { decision: "block", targets: [], failover_allowed: false }), { at: LATER });
    } else {
      const repo = "repo" in later ? later.repo : undefined;
      await p.sign(p.planOf("r-2", later.digest!, "patch" in later ? later.patch : {}), { at: LATER, ...(repo ? { repo } : {}) });
      if ("revoke" in later) await runRevoke({ auditPath: p.auditPath, digest: `sha256:${later.digest!.repeat(64)}`, reason: "mistake", by: "carol" });
    }
    const outcome = await runVerify({ resultPath: first.outPath, verifier: p.signer, auditPath: p.auditPath, latest: true });
    if (expected === "ok") expect(outcome).toMatchObject({ code: 0 });
    else expect(outcome).toMatchObject({ code: 1, reason: "superseded", detail: expect.stringMatching(/2번째 줄/) });
    // --latest 없이는 지금처럼 통과
    expect(await runVerify({ resultPath: first.outPath, verifier: p.signer, auditPath: p.auditPath })).toMatchObject({ code: 0 });
  });

  it("가장 새 결과는 --latest 로도 통과", async () => {
    const p = pipeline();
    await p.sign(p.planOf("r-1", "c"));
    const second = await p.sign(p.planOf("r-2", "d"), { at: LATER });
    expect(await runVerify({ resultPath: second.outPath, verifier: p.signer, auditPath: p.auditPath, latest: true })).toMatchObject({ code: 0 });
  });
});
