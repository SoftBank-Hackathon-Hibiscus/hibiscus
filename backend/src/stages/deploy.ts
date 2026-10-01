/**
 * 배포 단계.
 *   off  → 단계를 skipped 로 기록하고 deployment_performed=false
 *   dry  → 아직 미구현 (오류로 멈춤)
 *   real → 금지 규칙 확인 뒤 배포 조율기를 부른다
 *          python3 deploy/coordinator/coordinator.py <run>/sign/sign_result.json --out-dir <run>/deploy
 *          결과 파일 <run>/deploy/deploy_result.json, stdout 마지막 줄 JSON
 *          종료 코드 0 activated / 3 held / 4 rolled_back / 그 밖 error
 * 조율기(Python)는 TypeScript 로 옮기기 전까지의 기준 구현이다.
 * Cloud Run 설정(PROJECT_ID, REGION, SERVICE, PORT)과 서명 확인용 공개키(COSIGN_PUBLIC_KEY)는
 * backend 를 띄운 환경변수를 그대로 물려받는다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLastJsonLine } from "../command-runner.js";
import type { DeploymentRun } from "../models.js";
import { type StageContext, type StageOutcome, type StageRunner, tail } from "./types.js";

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

/** 조율기 종료 코드 → 단계 결과 */
export function outcomeFromCoordinator(
  code: number | null,
  summary: unknown,
  artifacts: Record<string, string>,
  stderr: string,
): StageOutcome {
  switch (code) {
    case 0:
      return { status: "succeeded", exit_code: code, artifacts, summary, runPatch: { deployment_performed: true } };
    case 3:
      return {
        status: "failed", exit_code: code, artifacts, summary,
        error: "검사를 통과하지 못해 전환하지 않음 (held: 기존 버전 유지)",
        runPatch: { deployment_performed: false },
      };
    case 4:
      return {
        status: "failed", exit_code: code, artifacts, summary,
        error: "전환 후 검사 실패로 롤백함 (rolled_back)",
        runPatch: { deployment_performed: true },
      };
    default:
      return {
        status: "failed", exit_code: code, artifacts, summary,
        error: `배포 조율기 오류 (종료 코드 ${code}): ${tail(stderr)}`,
        runPatch: { deployment_performed: false },
      };
  }
}

export class DeployStage implements StageRunner {
  readonly name = "deploy" as const;

  async run(ctx: StageContext): Promise<StageOutcome> {
    const { config, runner, run, paths } = ctx;
    const mode = config.deployMode;

    if (mode === "off") {
      return {
        status: "skipped",
        artifacts: {},
        summary: { mode, reason: "DEPLOY_MODE=off: 배포 조율기를 부르지 않았다" },
        runPatch: { deployment_performed: false },
      };
    }

    if (mode === "dry") {
      return {
        status: "failed",
        artifacts: {},
        error: "DEPLOY_MODE=dry 는 아직 구현되지 않았습니다",
        runPatch: { deployment_performed: false },
      };
    }

    const reason = realDeployBlockedReason(run, readSignatureRef(paths.sign));
    if (reason) return { status: "failed", artifacts: {}, error: reason, runPatch: { deployment_performed: false } };

    const r = await runner.run({
      command: "python3",
      args: [join(config.deployDir, "coordinator", "coordinator.py"), join(paths.sign, "sign_result.json"), "--out-dir", paths.deploy],
      cwd: config.repoRoot,
      timeoutMs: config.deployTimeoutMs,
    });

    const artifacts: Record<string, string> = {};
    const resultPath = join(paths.deploy, "deploy_result.json");
    if (existsSync(resultPath)) artifacts.deploy_result = paths.relative(resultPath);

    if (r.timedOut) {
      return {
        status: "failed", exit_code: r.code, artifacts,
        error: "배포 조율기 시간 초과 (Cloud Run 후보가 남아 있을 수 있음)",
        runPatch: { deployment_performed: false },
      };
    }
    return outcomeFromCoordinator(r.code, parseLastJsonLine(r.stdout), artifacts, r.stderr);
  }
}
