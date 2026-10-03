import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApproval } from "../src/approval.js";
import { DEPLOY_PREDICATE_TYPE, findDeployStatement } from "../src/attestation.js";
import { CONTRACTS, toJsonSchema } from "../src/contracts.js";
import type { ImageVerifier } from "../src/cosign.js";
import { canonicalize, sha256Hex, SignerError, writeJson } from "../src/io.js";
import { loadPlan } from "../src/plan.js";
import type { SignResult } from "../src/schema.js";
import { runSign } from "../src/sign.js";
import { runVerify } from "../src/verify.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { NOW, plan, readJsonFile, RecordingSigner, REPO, tmp } from "./helpers.js";

const validate = new Ajv2020({ strict: false }).compile(toJsonSchema(CONTRACTS.find((c) => c.name === "DeployAttestation")!));

async function signWith(dir: string, name: "allow-onprem" | "needs-approval", signer = new RecordingSigner(), attest = true) {
  const resultPath = join(dir, "sign_result.json");
  const approvalPath = join(dir, "approval.json");
  if (name === "needs-approval") writeJson(approvalPath, createApproval(loadPlan(plan(name)), "alice", "bob", NOW));
  const outcome = await runSign({
    planPath: plan(name),
    requester: "alice",
    ...(name === "needs-approval" ? { approvalPath } : {}),
    imageRepo: REPO,
    signer,
    attest,
    outPath: resultPath,
    logPath: join(dir, "d.jsonl"),
    auditPath: join(dir, "audit.jsonl"),
    now: () => NOW,
  });
  return { outcome, signer, resultPath, approvalPath };
}

describe("배포 증명서 만들기", () => {
  it("allow: 결정·위치·자동 승인(none)·plan 해시·걸린 규칙·감사 로그 끝이 들어감", async () => {
    const { outcome, signer, resultPath } = await signWith(tmp(), "allow-onprem");
    expect(outcome.code).toBe(0);
    const r = readJsonFile(resultPath);
    expect(signer.attests).toHaveLength(1);
    const [a] = signer.attests;
    expect(a!.predicateType).toBe(DEPLOY_PREDICATE_TYPE);
    expect(a!.imageRef).toBe(`${REPO}@${r.digest}`);
    expect(a!.predicate).toMatchObject({
      run_id: r.run_id,
      decision: "allow",
      targets: ["onprem"],
      failover_allowed: false,
      plan_hash: r.plan_hash,
      plan_sha256: loadPlan(plan("allow-onprem")).planSha256,
      matched_rules: ["R4"],
      requester: "alice",
      approver: "auto",
      approval_sha256: "none",
      audit_head: signer.calls[0]!.annotations.audit_head,
      signature_ref: r.signature_ref,
      signed_at: r.signed_at,
      signer: { name: "hibiscus-signer" },
    });
    expect(validate(a!.predicate)).toBe(true);
  });

  it("needs_approval: 승인자·승인 시각·승인 기록 해시가 들어감", async () => {
    const { signer, approvalPath } = await signWith(tmp(), "needs-approval");
    expect(signer.attests[0]!.predicate).toMatchObject({
      decision: "needs_approval",
      approver: "bob",
      approved_at: NOW.toISOString(),
      approval_sha256: sha256Hex(canonicalize(readJsonFile(approvalPath))),
    });
  });

  it("증명서를 못 붙이면 code 2, sign_result 없음 (증명서 없는 서명 결과로 배포되지 않게)", async () => {
    const signer = new (class extends RecordingSigner {
      override async attest(): Promise<void> {
        throw new SignerError("ATTEST_FAILED", "registry denied");
      }
    })();
    const dir = tmp();
    const { outcome, resultPath } = await signWith(dir, "allow-onprem", signer);
    expect(outcome).toMatchObject({ code: 2, reason: "sign_failed", detail: expect.stringMatching(/배포 증명서/) });
    expect(readJsonFile(join(dir, "d.jsonl"))).toMatchObject({ result: "refused", reason: "sign_failed" });
    await expect(import("node:fs").then((fs) => fs.existsSync(resultPath))).resolves.toBe(false);
  });

  it("attest 를 안 켜면 증명서를 안 붙임", async () => {
    const { signer } = await signWith(tmp(), "allow-onprem", new RecordingSigner(), false);
    expect(signer.attests).toHaveLength(0);
  });
});

describe("배포 증명서 확인 (verify --attestation)", () => {
  it("서명·증명서가 sign_result 와 같으면 통과 (allow, needs_approval)", async () => {
    for (const name of ["allow-onprem", "needs-approval"] as const) {
      const { signer, resultPath, approvalPath } = await signWith(tmp(), name);
      const extra = name === "needs-approval" ? { approvalPath } : {};
      expect(await runVerify({ resultPath, verifier: signer, attestation: {}, ...extra })).toMatchObject({ code: 0 });
    }
  });

  it("증명서 없이 서명만 한 이미지면 attestation_invalid", async () => {
    const { signer, resultPath } = await signWith(tmp(), "allow-onprem", new RecordingSigner(), false);
    expect(await runVerify({ resultPath, verifier: signer, attestation: {} })).toMatchObject({ code: 1, reason: "attestation_invalid" });
  });

  /** 서명 주석 확인은 통과시키고 증명서만 바꿔서 돌려주는 확인기 */
  function verifierWith(statements: unknown[] | Error): ImageVerifier {
    return {
      verify: async () => {},
      signatures: async () => [],
      attestations: async () => {
        if (statements instanceof Error) throw statements;
        return statements;
      },
    };
  }

  it.each([
    ["증명서의 targets 가 다름", (s: any) => ({ ...s, predicate: { ...s.predicate, targets: ["onprem", "cloud_run"] } }), /targets/],
    ["증명서의 승인자가 다름", (s: any) => ({ ...s, predicate: { ...s.predicate, approver: "mallory" } }), /approver/],
    ["다른 이미지에 붙은 증명서", (s: any) => ({ ...s, subject: [{ name: REPO, digest: { sha256: "e".repeat(64) } }] }), /subject/],
    ["다른 종류의 증명서", (s: any) => ({ ...s, predicateType: "https://slsa.dev/provenance/v1" }), /없음/],
    ["형식이 틀린 증명서", (s: any) => ({ ...s, predicate: { run_id: s.predicate.run_id } }), /형식/],
  ])("%s → attestation_invalid", async (_, mutate, detail) => {
    const { signer, resultPath } = await signWith(tmp(), "allow-onprem");
    const [statement] = await signer.attestations(`${REPO}@${readJsonFile(resultPath).digest}`, DEPLOY_PREDICATE_TYPE);
    const outcome = await runVerify({ resultPath, verifier: verifierWith([mutate(statement)]), attestation: {} });
    expect(outcome).toMatchObject({ code: 1, reason: "attestation_invalid", detail: expect.stringMatching(detail) });
  });

  it("Rego 정책에 걸리면 policy_denied", async () => {
    const { resultPath } = await signWith(tmp(), "allow-onprem");
    const denied = verifierWith(new SignerError("POLICY_DENIED", "배포 증명서가 정책에 맞지 않음: 1 validation errors occurred"));
    expect(await runVerify({ resultPath, verifier: denied, attestation: { policyPath: "deploy.rego" } })).toMatchObject({ code: 1, reason: "policy_denied" });
  });

  it("같은 이미지에 증명서가 여러 개면 sign_result 와 같은 것 하나만 있으면 통과", async () => {
    const { signer, resultPath } = await signWith(tmp(), "allow-onprem");
    const [statement] = (await signer.attestations(`${REPO}@${readJsonFile(resultPath).digest}`, DEPLOY_PREDICATE_TYPE)) as any[];
    const old = { ...statement, predicate: { ...statement.predicate, run_id: "r-old" } };
    expect(findDeployStatement([old, statement], readJsonFile(resultPath) as SignResult)).toMatchObject({ ok: true });
  });
});
