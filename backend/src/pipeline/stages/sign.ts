/**
 * 서명 단계: signer/ CLI 를 부른다.
 *   allow          → npm run sign -- --plan <plan> --requester <id> --image-repo <repo> [--dry-run] --out <run>/sign/sign_result.json --log <run>/decisions.jsonl
 *   needs_approval → (승인 뒤) npm run approve -- ... --out approval.json, 이어서 sign -- --approval approval.json
 *   block          → 오케스트레이터가 이 단계를 부르지 않는다
 * SIGNER_MODE=real 은 digest_source=registry 이고 source_revision_verified=true 일 때만 허용한다.
 * approve 와 sign 사이에 plan.json 을 다시 쓰지 않는다 (approval 은 plan 파일 해시에 묶임).
 * 성공하면 sign_result.json 이 contracts/SignResult.schema.json 과 맞는지, 지금 run 과 plan 을 가리키는지 확인한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { npmCommand } from "../../infrastructure/command-runner.js";
import { contractViolation } from "../contracts.js";
import type { DeploymentRun } from "../models.js";
import { type PlanLike, readPlan } from "./policy.js";
import { type StageContext, type StageOutcome, type StageRunner, tail } from "./types.js";

export interface SignResult {
  run_id: string;
  digest: string;
  source_revision?: string;
  plan_hash: string;
  targets: string[];
  failover_allowed: boolean;
  requester: string;
  approver: string;
  signature_ref: string;
  signed_at: string;
}

/** real 서명을 막아야 하는 이유. 없으면 undefined */
export function realSignBlockedReason(run: DeploymentRun): string | undefined {
  if (run.digest_source !== "registry") return `SIGNER_MODE=real 은 레지스트리 digest 가 있을 때만 허용 (digest_source=${run.digest_source})`;
  if (!run.source_revision_verified) return "SIGNER_MODE=real 은 source_revision 이 HEAD 로 검증됐을 때만 허용 (source_revision_verified=false)";
  return undefined;
}

/** sign_result.json 이 지금 run·plan 과 다른 점. 비어 있으면 같은 실행·이미지·계획 */
export function signResultMismatches(result: SignResult, run: DeploymentRun, plan: PlanLike): string[] {
  const out: string[] = [];
  if (result.run_id !== run.run_id) out.push(`sign_result.run_id=${result.run_id} 인데 run.run_id=${run.run_id}`);
  if (result.digest !== run.digest) out.push(`sign_result.digest=${result.digest} 인데 run.digest=${run.digest}`);
  if (result.plan_hash !== plan.plan_hash) out.push(`sign_result.plan_hash=${result.plan_hash} 인데 plan.plan_hash=${plan.plan_hash}`);
  return out;
}

export class SignStage implements StageRunner {
  readonly name = "sign" as const;

  async run(ctx: StageContext): Promise<StageOutcome> {
    const { config, runner, app, run, paths, approval } = ctx;
    const planPath = join(paths.policy, "plan.json");
    const artifacts: Record<string, string> = {};

    if (run.decision === "block") return { status: "failed", artifacts, error: "block 결정은 서명하지 않는다" };
    if (run.decision === "needs_approval" && approval === undefined) {
      return { status: "failed", artifacts, error: "needs_approval 인데 승인 정보가 없음" };
    }
    const read = readPlan(paths.policy);
    if ("error" in read) return { status: "failed", artifacts, error: read.error };

    const dryRun = config.signerMode === "dry";
    if (!dryRun) {
      const reason = realSignBlockedReason(run);
      if (reason) return { status: "failed", artifacts, error: reason };
    }

    const common = { command: npmCommand(), cwd: config.signerDir, timeoutMs: config.signerTimeoutMs };
    let approvalPath: string | undefined;
    if (approval) {
      approvalPath = join(paths.sign, "approval.json");
      const a = await runner.run({
        ...common,
        args: ["run", "approve", "--", "--plan", planPath, "--requester", run.requester, "--approver", approval.approver, "--out", approvalPath],
      });
      if (a.code !== 0) {
        return { status: "failed", exit_code: a.code, artifacts, error: `승인 기록 생성 실패 (종료 코드 ${a.code}): ${tail(a.stderr) || tail(a.stdout)}` };
      }
      if (existsSync(approvalPath)) artifacts.approval = paths.relative(approvalPath);
    }

    const signResultPath = join(paths.sign, "sign_result.json");
    const args = ["run", "sign", "--", "--plan", planPath, "--requester", run.requester];
    if (approvalPath) args.push("--approval", approvalPath);
    args.push("--image-repo", app.image_repo, "--out", signResultPath, "--log", paths.decisionsLog);
    if (dryRun) args.push("--dry-run");
    const s = await runner.run({ ...common, args });

    if (existsSync(paths.decisionsLog)) artifacts.decisions_log = paths.relative(paths.decisionsLog);
    if (s.timedOut) return { status: "failed", exit_code: s.code, artifacts, error: "signer CLI 시간 초과" };
    if (s.code === 1) return { status: "failed", exit_code: 1, artifacts, error: `서명 거절: ${tail(s.stderr) || tail(s.stdout)}` };
    if (s.code !== 0) return { status: "failed", exit_code: s.code, artifacts, error: `signer CLI 오류 (종료 코드 ${s.code}): ${tail(s.stderr) || tail(s.stdout)}` };
    if (!existsSync(signResultPath)) return { status: "failed", exit_code: 0, artifacts, error: "signer 가 sign_result.json 을 남기지 않음" };

    artifacts.sign_result = paths.relative(signResultPath);
    let signResult: SignResult;
    try {
      signResult = JSON.parse(readFileSync(signResultPath, "utf8")) as SignResult;
    } catch (e) {
      return { status: "failed", exit_code: 0, artifacts, error: `sign_result.json 을 읽지 못함: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 파트 경계 검증: 계약 형식 → 같은 실행·이미지·계획인지
    const violation = contractViolation(join(config.contractsDir, "SignResult.schema.json"), signResult, "sign_result.json");
    if (violation) return { status: "failed", exit_code: 0, artifacts, error: violation };
    const mismatches = signResultMismatches(signResult, run, read.plan);
    if (mismatches.length > 0) return { status: "failed", exit_code: 0, artifacts, error: `sign_result.json 이 지금 run·plan 과 다름: ${mismatches.join("; ")}` };

    return {
      status: "succeeded",
      exit_code: 0,
      artifacts,
      summary: { mode: config.signerMode, approver: signResult.approver, signature_ref: signResult.signature_ref, targets: signResult.targets, plan_hash: signResult.plan_hash },
    };
  }
}
