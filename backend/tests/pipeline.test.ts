import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_INPUT, REGISTRY_DIGEST, get, gitHandler, makeHarness, policyHandler, post, runOnce, signerHandler, stageOf } from "./helpers.js";

describe("수동 실행 한 바퀴 (가짜 명령)", () => {
  it("allow → succeeded, deploy=skipped, deployment_performed=false", async () => {
    const h = makeHarness([gitHandler(), policyHandler("allow"), signerHandler()]);
    const { view } = await runOnce(h);
    const run = view!.run;

    expect(run.status).toBe("succeeded");
    expect(run.decision).toBe("allow");
    expect(run.execution_mode).toBe("skeleton");
    expect(run.deployment_performed).toBe(false);
    expect(run.digest_source).toBe("placeholder");
    expect(run.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.source_revision_verified).toBe(true);
    expect(run.current_stage).toBe("deploy");

    expect(view!.stages.map((s) => [s.stage, s.status])).toEqual([
      ["test", "succeeded"],
      ["policy", "succeeded"],
      ["sign", "succeeded"],
      ["deploy", "skipped"],
    ]);
    expect(stageOf(view!, "sign").summary.signature_ref).toMatch(/^dry-run:/);
    expect(stageOf(view!, "sign").summary.approver).toBe("auto");
    expect(stageOf(view!, "deploy").summary.mode).toBe("off");

    // 산출물은 WORK_DIR 기준 상대 경로
    const plan = stageOf(view!, "policy").artifacts.plan;
    expect(plan).toBe(`runs/${run.run_id}/policy/plan.json`);
    expect(existsSync(join(h.workDir, plan))).toBe(true);
    expect(stageOf(view!, "sign").artifacts.sign_result).toBe(`runs/${run.run_id}/sign/sign_result.json`);

    // 정책 CLI 는 policy/ 에서 run 별 --log 로 호출
    const policyCall = h.runner.npmCalls("stage")[0]!;
    expect(policyCall.cwd).toMatch(/[\\/]policy$/);
    expect(policyCall.args).toContain("--source-revision");
    expect(policyCall.args[policyCall.args.indexOf("--log") + 1]).toBe(join(h.workDir, "runs", run.run_id, "decisions.jsonl"));
    expect(policyCall.args).toContain("--json");
    expect(policyCall.args).toContain("--explain");
    // 서명은 dry-run
    const signCall = h.runner.npmCalls("sign")[0]!;
    expect(signCall.args).toContain("--dry-run");
    expect(signCall.cwd).toMatch(/[\\/]signer$/);
  });

  it("needs_approval → awaiting_approval → approve 뒤 succeeded", async () => {
    const h = makeHarness([gitHandler(), policyHandler("needs_approval"), signerHandler()]);
    const { view } = await runOnce(h);
    expect(view!.run.status).toBe("awaiting_approval");
    expect(view!.run.current_stage).toBe("sign");
    expect(view!.stages.map((s) => s.stage)).toEqual(["test", "policy"]);

    const runId = view!.run.run_id;
    const approved = await post(h.app, `/runs/${runId}/approve`, { approver: "seungpyo" });
    expect(approved.status).toBe(202);
    expect(approved.json.status).toBe("running");
    await h.service.waitFor(runId);

    const after = (await get(h.app, `/runs/${runId}`)).json;
    expect(after.run.status).toBe("succeeded");
    expect(after.run.deployment_performed).toBe(false);
    expect(after.stages.map((s: any) => [s.stage, s.status])).toEqual([
      ["test", "succeeded"],
      ["policy", "succeeded"],
      ["sign", "succeeded"],
      ["deploy", "skipped"],
    ]);
    const sign = stageOf(after, "sign");
    expect(sign.summary.approver).toBe("seungpyo");
    expect(sign.artifacts.approval).toBe(`runs/${runId}/sign/approval.json`);

    // approve 와 sign 사이에 plan.json 을 다시 쓰지 않는다: approve 호출 뒤 stage 재호출 없음
    const order = h.runner.calls.filter((c) => /^npm/.test(c.command)).map((c) => c.args[1]);
    expect(order).toEqual(["stage", "approve", "sign"]);

    // 다시 승인하면 409
    const again = await post(h.app, `/runs/${runId}/approve`, { approver: "seungpyo" });
    expect(again.status).toBe(409);
  });

  it("block → blocked, 서명·배포 단계 없음", async () => {
    const h = makeHarness([gitHandler(), policyHandler("block"), signerHandler()]);
    const { view } = await runOnce(h);
    expect(view!.run.status).toBe("blocked");
    expect(view!.run.decision).toBe("block");
    expect(view!.stages.map((s) => s.stage)).toEqual(["test", "policy"]);
    expect(h.runner.npmCalls("sign")).toHaveLength(0);
  });

  it("정책 CLI 오류(종료 코드 1) → failed", async () => {
    const h = makeHarness([gitHandler(), policyHandler({ error: "test_result 형식 오류" }), signerHandler()]);
    const { view } = await runOnce(h);
    expect(view!.run.status).toBe("failed");
    expect(view!.run.error).toContain("[policy]");
    expect(view!.run.error).toContain("종료 코드 1");
    expect(stageOf(view!, "policy").status).toBe("failed");
    expect(stageOf(view!, "policy").exit_code).toBe(1);
    expect(view!.run.decision).toBeUndefined();
  });

  it("placeholder digest + SIGNER_MODE=real → 서명 단계 오류", async () => {
    const h = makeHarness([gitHandler(), policyHandler("allow"), signerHandler()], { SIGNER_MODE: "real" });
    const { view } = await runOnce(h);
    expect(view!.run.status).toBe("failed");
    expect(view!.run.error).toContain("digest_source=placeholder");
    expect(stageOf(view!, "sign").status).toBe("failed");
    expect(h.runner.npmCalls("sign")).toHaveLength(0);
  });

  it("source_revision_verified=false + SIGNER_MODE=real → 서명 단계 오류", async () => {
    const h = makeHarness([gitHandler({ dirty: true }), policyHandler("allow"), signerHandler()], { SIGNER_MODE: "real" });
    const { view } = await runOnce(h, { requester: "ryu", digest: REGISTRY_DIGEST });
    expect(view!.run.digest_source).toBe("registry");
    expect(view!.run.source_revision_verified).toBe(false);
    expect(view!.run.status).toBe("failed");
    expect(view!.run.error).toContain("source_revision_verified=false");
    expect(h.runner.npmCalls("sign")).toHaveLength(0);
  });

  it("본인 승인 → 403, awaiting_approval 유지 → 다른 승인자가 승인하면 succeeded", async () => {
    const h = makeHarness([gitHandler(), policyHandler("needs_approval"), signerHandler()]);
    const { view } = await runOnce(h, { requester: "ryu" });
    const runId = view!.run.run_id;

    const self = await post(h.app, `/runs/${runId}/approve`, { approver: "ryu" });
    expect(self.status).toBe(403);
    expect(self.json.error).toContain("본인");
    // signer 를 부르지 않았고 상태는 그대로
    expect(h.runner.npmCalls("approve")).toHaveLength(0);
    expect((await get(h.app, `/runs/${runId}`)).json.run.status).toBe("awaiting_approval");

    const other = await post(h.app, `/runs/${runId}/approve`, { approver: "seungpyo" });
    expect(other.status).toBe(202);
    await h.service.waitFor(runId);
    const after = (await get(h.app, `/runs/${runId}`)).json;
    expect(after.run.status).toBe("succeeded");
    expect(stageOf(after, "sign").summary.approver).toBe("seungpyo");
  });

  it("같은 run 에 거의 동시에 온 승인 2개 → 하나만 202, signer approve·sign 은 한 번씩", async () => {
    const h = makeHarness([gitHandler(), policyHandler("needs_approval"), signerHandler()]);
    const { view } = await runOnce(h, { requester: "ryu" });
    const runId = view!.run.run_id;

    const [a, b] = await Promise.all([
      post(h.app, `/runs/${runId}/approve`, { approver: "seungpyo" }),
      post(h.app, `/runs/${runId}/approve`, { approver: "taehyun" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await h.service.waitFor(runId);

    expect(h.runner.npmCalls("approve")).toHaveLength(1);
    expect(h.runner.npmCalls("sign")).toHaveLength(1);
    const after = (await get(h.app, `/runs/${runId}`)).json;
    expect(after.run.status).toBe("succeeded");
    expect(after.stages.filter((s: any) => s.stage === "sign")).toHaveLength(1);
    const winner = a.status === 202 ? "seungpyo" : "taehyun";
    expect(stageOf(after, "sign").summary.approver).toBe(winner);
  });

  it("real 모드에서 stub 승인 → 403", async () => {
    const h = makeHarness([gitHandler(), policyHandler("needs_approval"), signerHandler()], { SIGNER_MODE: "real" });
    const { view } = await runOnce(h, { requester: "ryu", digest: REGISTRY_DIGEST });
    expect(view!.run.status).toBe("awaiting_approval");
    const res = await post(h.app, `/runs/${view!.run.run_id}/approve`, { approver: "seungpyo" });
    expect(res.status).toBe(403);
    expect((await get(h.app, `/runs/${view!.run.run_id}`)).json.run.status).toBe("awaiting_approval");
  });

  it("두 run 을 연달아 돌려도 decisions.jsonl 은 run 별 폴더에 따로 생긴다", async () => {
    const h = makeHarness([gitHandler(), policyHandler("allow"), signerHandler()]);
    const first = await runOnce(h);
    const second = await runOnce(h);
    const a = first.view!.run.run_id;
    const b = second.view!.run.run_id;
    expect(a).not.toBe(b);

    const logA = join(h.workDir, "runs", a, "decisions.jsonl");
    const logB = join(h.workDir, "runs", b, "decisions.jsonl");
    expect(existsSync(logA)).toBe(true);
    expect(existsSync(logB)).toBe(true);
    expect(existsSync(join(h.workDir, "decisions.jsonl"))).toBe(false);

    for (const [log, runId] of [[logA, a], [logB, b]] as const) {
      const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.kind)).toEqual(["deploy", "sign"]);
      expect(lines.every((l) => l.run_id === runId)).toBe(true);
    }
    expect(stageOf(first.view!, "policy").artifacts.decisions_log).toBe(`runs/${a}/decisions.jsonl`);
  });
});

describe("source_revision 확정", () => {
  it("요청 source_revision ≠ HEAD → 400, run 없음", async () => {
    const h = makeHarness([gitHandler(), policyHandler("allow"), signerHandler()]);
    const { started } = await runOnce(h, { requester: "ryu", source_revision: "ffffffff" });
    expect(started.status).toBe(400);
    expect(started.json.error).toContain("HEAD");
    expect(h.runner.npmCalls("stage")).toHaveLength(0);
  });

  it("요청 source_revision 이 HEAD 의 앞부분이면 전체 SHA 로 확정, verified=true", async () => {
    const h = makeHarness([gitHandler(), policyHandler("allow"), signerHandler()]);
    const { view } = await runOnce(h, { requester: "ryu", source_revision: "0123456" });
    expect(view!.run.source_revision).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(view!.run.source_revision_verified).toBe(true);
  });

  it("git 저장소가 아니고 요청 값도 없으면 400", async () => {
    const h = makeHarness([gitHandler({ head: undefined }), policyHandler("allow"), signerHandler()]);
    const { started } = await runOnce(h);
    expect(started.status).toBe(400);
  });

  it("git 저장소가 아니면 요청 값을 쓰되 verified=false", async () => {
    const h = makeHarness([gitHandler({ head: undefined }), policyHandler("allow"), signerHandler()]);
    const { view } = await runOnce(h, { requester: "ryu", source_revision: "abcdef1234" });
    expect(view!.run.source_revision).toBe("abcdef1234");
    expect(view!.run.source_revision_verified).toBe(false);
    expect(view!.run.status).toBe("succeeded"); // dry 서명은 허용
  });
});

describe("API 입력 검사", () => {
  it("앱 입력 오류 → 400, 없는 run → 404", async () => {
    const h = makeHarness([gitHandler()]);
    expect((await post(h.app, "/apps", { ...APP_INPUT, image_repo: "Bad Repo" })).status).toBe(400);
    expect((await post(h.app, "/apps", { ...APP_INPUT, src_path: "no-such-folder" })).status).toBe(400);
    expect((await get(h.app, "/runs/none")).status).toBe(404);
    expect((await post(h.app, "/apps/none/runs", { requester: "ryu" })).status).toBe(404);
  });

  it("GET /apps 에 등록한 앱이 보인다", async () => {
    const h = makeHarness([gitHandler()]);
    const created = await post(h.app, "/apps", APP_INPUT);
    expect(created.status).toBe(201);
    expect(created.json.test_template).toBe("allow");
    const list = await get(h.app, "/apps");
    expect(list.json.map((a: any) => a.id)).toEqual([created.json.id]);
  });
});
