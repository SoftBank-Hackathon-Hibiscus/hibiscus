import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAnchor } from "../src/anchor.js";
import { runRevoke } from "../src/revoke.js";
import { runReconcile } from "../src/reconcile.js";
import { runSign } from "../src/sign.js";
import { NOW, plan, readJsonFile, RecordingSigner, REPO, tmp } from "./helpers.js";

/** allow-onprem(개인정보 앱, targets onprem) 한 번 서명 */
async function signed() {
  const dir = tmp();
  const signer = new RecordingSigner();
  const auditPath = join(dir, "sign_audit.jsonl");
  const outPath = join(dir, "sign_result.json");
  await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath, logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW });
  const image = `${REPO}@${readJsonFile(outPath).digest}`;
  const observe = (rows: Array<{ target: string; image?: string }>) => {
    const path = join(dir, `observed-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(path, rows.map((r) => JSON.stringify({ kind: "observed", target: r.target, image: r.image ?? image, observed_at: NOW.toISOString(), source: "test" })).join("\n") + "\n");
    return path;
  };
  return { dir, signer, auditPath, image, observe };
}

describe("signer reconcile (실제 배포 상태 대조)", () => {
  it("서명한 위치(onprem)에 서명한 이미지가 떠 있으면 0", async () => {
    const s = await signed();
    expect(await runReconcile({ observedPath: s.observe([{ target: "onprem" }]), auditPath: s.auditPath, verifier: s.signer })).toEqual({ code: 0, checked: 1, failures: [] });
  });

  it("sign_result 를 고쳐 cloud_run 에 띄웠으면 target_not_signed (서명은 멀쩡해도)", async () => {
    const s = await signed();
    expect(await runReconcile({ observedPath: s.observe([{ target: "onprem" }, { target: "cloud_run" }]), auditPath: s.auditPath, verifier: s.signer })).toMatchObject({
      code: 1,
      checked: 2,
      failures: [{ line: 2, target: "cloud_run", reason: "target_not_signed", detail: expect.stringMatching(/onprem \(run r-003\) \/ 관측 cloud_run/) }],
    });
  });

  it("targets 를 바꾼 쌍둥이 서명이 레지스트리에 있어도 target_not_signed (기록과 정확히 같은 서명만 인정)", async () => {
    const s = await signed();
    const c = s.signer.calls[0]!;
    await s.signer.sign(c.imageRef, { ...c.annotations, targets: "onprem+cloud_run", failover_allowed: "true" });
    expect(await runReconcile({ observedPath: s.observe([{ target: "cloud_run" }]), auditPath: s.auditPath, verifier: s.signer })).toMatchObject({ code: 1, failures: [{ reason: "target_not_signed" }] });
  });

  it("감사 로그에 없는 이미지 → deploy_unlogged, 기록은 있는데 서명이 없음 → deploy_unsigned, 철회 → deploy_revoked", async () => {
    const s = await signed();
    const other = `${REPO}@sha256:${"9".repeat(64)}`;
    expect(await runReconcile({ observedPath: s.observe([{ target: "onprem", image: other }]), auditPath: s.auditPath, verifier: s.signer })).toMatchObject({ failures: [{ reason: "deploy_unlogged" }] });
    expect(await runReconcile({ observedPath: s.observe([{ target: "onprem" }]), auditPath: s.auditPath, verifier: new RecordingSigner() })).toMatchObject({ failures: [{ reason: "deploy_unsigned" }] });
    await runRevoke({ auditPath: s.auditPath, digest: s.image.split("@")[1]!, reason: "vulnerability", by: "carol" });
    expect(await runReconcile({ observedPath: s.observe([{ target: "onprem" }]), auditPath: s.auditPath, verifier: s.signer })).toMatchObject({ failures: [{ reason: "deploy_revoked", detail: expect.stringMatching(/2번째 줄/) }] });
  });

  it.each([
    ["JSON 아님", "not json"],
    ["image 에 태그", JSON.stringify({ kind: "observed", target: "onprem", image: `${REPO}:v1`, observed_at: "t", source: "x" })],
    ["target 대문자", JSON.stringify({ kind: "observed", target: "OnPrem", image: `${REPO}@sha256:${"a".repeat(64)}`, observed_at: "t", source: "x" })],
  ])("틀린 관측 줄은 줄 번호와 같이 OBSERVED_INVALID (%s)", async (_name, line) => {
    const s = await signed();
    const path = join(s.dir, "bad.jsonl");
    writeFileSync(path, `${JSON.stringify({ kind: "observed", target: "onprem", image: s.image, observed_at: "t", source: "x" })}\n${line}\n`);
    await expect(runReconcile({ observedPath: path, auditPath: s.auditPath, verifier: s.signer })).rejects.toMatchObject({ code: "OBSERVED_INVALID", message: expect.stringMatching(/2번째 줄/) });
  });

  it("감사 로그 체인이 깨졌거나 끝이 잘렸으면 그 이유로 실패", async () => {
    const s = await signed();
    const anchors = join(s.dir, "anchors.jsonl");
    await runAnchor({ auditPath: s.auditPath, anchorsPath: anchors, signer: s.signer });
    const observedPath = s.observe([{ target: "onprem" }]);
    writeFileSync(s.auditPath, "");
    expect(await runReconcile({ observedPath, auditPath: s.auditPath, verifier: s.signer, anchors: { path: anchors, verifier: s.signer } })).toMatchObject({ code: 1, reason: "anchor_truncated" });
    writeFileSync(s.auditPath, "{}\n");
    expect(await runReconcile({ observedPath, auditPath: s.auditPath, verifier: s.signer })).toMatchObject({ code: 1, reason: "line_invalid" });
    expect(readFileSync(observedPath, "utf8")).toContain("onprem");
  });
});
