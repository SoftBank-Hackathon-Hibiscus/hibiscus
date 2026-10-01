/**
 * 배포 단계. 이번에는 DEPLOY_MODE=off 만 구현한다: 단계를 skipped 로 기록하고 deployment_performed=false.
 * dry·real 은 자리만 있고 "미구현" 오류로 멈춘다. deploy_result 의 형식은 배포 파트가 정하므로 백엔드가 합성하지 않는다.
 * real 배포를 막는 규칙은 미리 넣어 둔다: dry-run 서명, 검증 안 된 source_revision, 자리표시자 digest.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentRun } from "../models.js";
import type { StageContext, StageOutcome, StageRunner } from "./types.js";

/** real 배포를 막아야 하는 이유. 없으면 undefined */
export function realDeployBlockedReason(run: DeploymentRun, signatureRef: string | undefined): string | undefined {
  if (signatureRef === undefined) return "sign_result 가 없어 배포할 수 없음";
  if (signatureRef.startsWith("dry-run:")) return `dry-run 서명은 배포하지 않음 (signature_ref=${signatureRef})`;
  if (!run.source_revision_verified) return "source_revision 이 HEAD 로 검증되지 않아 real 배포 금지 (source_revision_verified=false)";
  if (run.digest_source !== "registry") return `레지스트리 digest 가 아니라 real 배포 금지 (digest_source=${run.digest_source})`;
  return undefined;
}

function readSignatureRef(signDir: string): string | undefined {
  const p = join(signDir, "sign_result.json");
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { signature_ref?: unknown };
    return typeof parsed.signature_ref === "string" ? parsed.signature_ref : undefined;
  } catch {
    return undefined;
  }
}

export class DeployStage implements StageRunner {
  readonly name = "deploy" as const;

  async run(ctx: StageContext): Promise<StageOutcome> {
    const { config, run, paths } = ctx;
    const mode = config.deployMode;

    if (mode === "off") {
      return {
        status: "skipped",
        artifacts: {},
        summary: { mode, reason: "DEPLOY_MODE=off: 배포 조율기를 부르지 않았다" },
        runPatch: { deployment_performed: false },
      };
    }

    if (mode === "real") {
      const reason = realDeployBlockedReason(run, readSignatureRef(paths.sign));
      if (reason) return { status: "failed", artifacts: {}, error: reason, runPatch: { deployment_performed: false } };
    }

    return {
      status: "failed",
      artifacts: {},
      error: `DEPLOY_MODE=${mode} 는 아직 구현되지 않았습니다. deploy_result 형식이 정해지면 coordinator 호출을 연결한다`,
      runPatch: { deployment_performed: false },
    };
  }
}
