/**
 * 실제 CLI 를 부르는 통합 테스트: policy stage 1회 (fixture 템플릿, sample-app 소스), signer --dry-run 1회.
 * cosign, gcloud, Docker 없이 돈다. policy/ 와 signer/ 에 node_modules 가 있어야 한다.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildService } from "../src/build.js";
import { BACKEND_ROOT, loadConfig } from "../src/config.js";
import { APP_INPUT, get, post, stageOf } from "./helpers.js";

const config = loadConfig({ WORK_DIR: mkdtempSync(join(tmpdir(), "hibiscus-backend-it-")), SIGNER_MODE: "dry", DEPLOY_MODE: "off" }, BACKEND_ROOT);
const ready = existsSync(join(config.policyDir, "node_modules")) && existsSync(join(config.signerDir, "node_modules"));

describe.skipIf(!ready)("실제 policy stage + signer dry-run", () => {
  it("sample-app 으로 한 바퀴: plan.json, sign_result.json(dry-run), run 별 decisions.jsonl", async () => {
    const service = buildService(config);
    const app = createApp(service);

    const created = await post(app, "/apps", APP_INPUT);
    expect(created.status).toBe(201);
    const started = await post(app, `/apps/${created.json.id}/runs`, { requester: "ryu" });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    const runId = started.json.run_id as string;
    await service.waitFor(runId);

    const view = (await get(app, `/runs/${runId}`)).json;
    const run = view.run;
    expect(run.error, run.error).toBeUndefined();
    expect(run.execution_mode).toBe("skeleton");
    expect(run.digest_source).toBe("placeholder");
    expect(run.deployment_performed).toBe(false);
    expect(run.source_revision).toMatch(/^[0-9a-f]{40}$/);

    // 정책: 실제 CLI 가 plan.json 을 쓰고 종료 코드로 결정을 알린다
    const policy = stageOf(view, "policy");
    expect(policy.status).toBe("succeeded");
    expect(["allow", "needs_approval", "block"]).toContain(run.decision);
    const plan = JSON.parse(readFileSync(join(config.workDir, policy.artifacts.plan), "utf8"));
    expect(plan.run_id).toBe(runId);
    expect(plan.digest).toBe(run.digest);
    expect(plan.source_revision).toBe(run.source_revision);
    expect(plan.decision).toBe(run.decision);
    expect(policy.summary.decision).toBe(run.decision);
    expect(existsSync(join(config.workDir, policy.artifacts.explain_ko))).toBe(true);

    const log = join(config.workDir, "runs", runId, "decisions.jsonl");
    expect(existsSync(log)).toBe(true);
    expect(existsSync(join(config.workDir, "decisions.jsonl"))).toBe(false);

    // allow 템플릿이라 서명까지 간다. 서명은 cosign 없이 --dry-run
    if (run.decision === "allow") {
      expect(run.status).toBe("succeeded");
      const sign = stageOf(view, "sign");
      expect(sign.status).toBe("succeeded");
      const signResult = JSON.parse(readFileSync(join(config.workDir, sign.artifacts.sign_result), "utf8"));
      expect(signResult.signature_ref).toBe(`dry-run:${APP_INPUT.image_repo}@${run.digest}`);
      expect(signResult.approver).toBe("auto");
      expect(signResult.plan_hash).toBe(plan.plan_hash);
      expect(stageOf(view, "deploy").status).toBe("skipped");

      const kinds = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
      expect(kinds).toEqual(["deploy", "sign"]);
    } else {
      expect(["awaiting_approval", "blocked"]).toContain(run.status);
    }
  }, 180_000);
});
