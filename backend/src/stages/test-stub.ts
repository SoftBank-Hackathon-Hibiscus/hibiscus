/**
 * 테스트 단계 stub. 실제 parity 호출 방법이 정해질 때까지 템플릿에서 test_result.json 을 만든다.
 * run 의 run_id, digest, source_revision 을 채워 넣어 정책 단계의 run_id 대조가 맞게 한다.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext, StageOutcome, StageRunner } from "./types.js";

/** 레지스트리 digest 가 아직 없을 때 쓰는 자리표시자. run_id 로 결정되며 형식만 맞춘 값이다 */
export function placeholderDigest(runId: string): string {
  return `sha256:${createHash("sha256").update(`placeholder:${runId}`, "utf8").digest("hex")}`;
}

export class TestStubStage implements StageRunner {
  readonly name = "test" as const;

  async run(ctx: StageContext): Promise<StageOutcome> {
    const { run, app, paths, config } = ctx;
    const templatePath = join(config.templatesDir, `${app.test_template}.json`);
    let template: Record<string, unknown>;
    try {
      template = JSON.parse(readFileSync(templatePath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      return { status: "failed", artifacts: {}, error: `테스트 템플릿을 읽지 못함: ${templatePath} (${e instanceof Error ? e.message : String(e)})` };
    }

    const testResult = {
      ...template,
      run_id: run.run_id,
      app: app.name,
      digest: run.digest,
      source_revision: run.source_revision,
    };
    const outPath = join(paths.test, "test_result.json");
    writeFileSync(outPath, JSON.stringify(testResult, null, 2) + "\n", "utf8");

    return {
      status: "succeeded",
      exit_code: 0,
      artifacts: { test_result: paths.relative(outPath) },
      summary: {
        stub: true,
        template: app.test_template,
        digest_source: run.digest_source,
        note: "실제 테스트를 실행하지 않았다. parity 호출 방법이 정해지면 교체한다",
      },
    };
  }
}
