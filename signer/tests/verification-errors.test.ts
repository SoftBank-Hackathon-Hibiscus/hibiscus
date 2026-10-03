import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit } from "../src/audit.js";
import { CosignVerifier } from "../src/cosign.js";
import { signLogLine } from "../src/io.js";
import { runAuditVerify } from "../src/verify.js";
import { fakeCosign, NOW, REPO, tmp } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

async function fixture(options: Parameters<typeof fakeCosign>[1]) {
  const dir = tmp();
  const pub = join(dir, "cosign.pub");
  writeFileSync(pub, "synthetic public key");
  const { bin } = fakeCosign(dir, options);
  const auditPath = join(dir, "audit.jsonl");
  await appendAudit(auditPath, signLogLine({
    run_id: "r-1", digest: DIGEST, plan_hash: "b".repeat(64), result: "refused",
    requester: "alice", approver: null, reason: "policy_block", signature_ref: null,
  }, NOW), undefined);
  return { bin, options: { auditPath, verifier: new CosignVerifier(pub, bin), imageRepo: REPO } };
}

describe("감사 이미지 검증 오류", () => {
  it("서명 검증 실패를 서명 없음으로 바꿔 감사 성공으로 남기지 않는다", async () => {
    const { options } = await fixture({ code: 1, stderr: "Error: not enough verified log entries from transparency log: 0 < 1" });
    expect(await runAuditVerify(options)).toMatchObject({ code: 1, reason: "signature_invalid" });
  });

  it("알 수 없는 cosign 오류를 서명 없음으로 숨기지 않는다", async () => {
    const { options } = await fixture({ code: 2, stderr: "Error: unexpected verifier initialization failure" });
    await expect(runAuditVerify(options)).rejects.toMatchObject({ code: "VERIFY_FAILED" });
  });

  it.skipIf(process.platform === "win32")("실행 권한 오류를 서명 없음으로 숨기지 않는다", async () => {
    const { bin, options } = await fixture({});
    chmodSync(bin, 0o600);
    // cosign 버전 확인에서 먼저 실행 오류(2)로 멈춤
    await expect(runAuditVerify(options)).rejects.toMatchObject({ code: "COSIGN_VERSION_UNKNOWN" });
  });

  it.each(["", "not JSON", "{}", "[null]", '[{"optional":"invalid"}]'])("잘못된 성공 출력(%j)을 서명 없음으로 숨기지 않는다", async (stdout) => {
    const { options } = await fixture({ stdout });
    await expect(runAuditVerify(options)).rejects.toMatchObject({ code: "VERIFY_OUTPUT_INVALID" });
  });

  it("들여쓰기된 정상 JSON에서도 로그에 없는 서명을 찾는다", async () => {
    const { options } = await fixture({ stdout: JSON.stringify([{ optional: { run_id: "r-hidden", audit_head: "0".repeat(64) } }], null, 2) });
    expect(await runAuditVerify(options)).toMatchObject({ code: 1, reason: "unlogged_signature" });
  });

  it("명시적으로 서명이 없다는 응답은 정상 거절 기록과 대조할 수 있다", async () => {
    const { options } = await fixture({ code: 1, stderr: "Error: no signatures found" });
    expect(await runAuditVerify(options)).toMatchObject({ code: 0, signed: 0, images: 1 });
  });
});
