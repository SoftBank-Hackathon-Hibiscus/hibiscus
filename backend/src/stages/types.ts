/** 단계 공통 인터페이스. 오케스트레이터는 이 모양만 보고 단계를 차례로 부른다 */
import type { CommandRunner } from "../command-runner.js";
import type { Config } from "../config.js";
import type { DeploymentApp, DeploymentRun, StageName } from "../models.js";
import type { RunPaths } from "../paths.js";

export interface StageContext {
  config: Config;
  runner: CommandRunner;
  app: DeploymentApp;
  run: DeploymentRun;
  paths: RunPaths;
  /** needs_approval 뒤 서명 단계에만 있음 */
  approval?: { approver: string };
}

export interface StageOutcome {
  status: "succeeded" | "failed" | "skipped";
  exit_code?: number | null;
  /** 산출물 이름 → WORK_DIR 기준 상대 경로 */
  artifacts: Record<string, string>;
  summary?: unknown;
  error?: string;
  /** 단계가 run 에 반영할 값 (정책 결정 등) */
  runPatch?: Partial<DeploymentRun>;
}

export interface StageRunner {
  readonly name: StageName;
  run(ctx: StageContext): Promise<StageOutcome>;
}

/** stderr 끝부분만 오류 메시지로 쓴다 */
export function tail(text: string, lines = 8): string {
  const all = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  return all.slice(-lines).join("\n");
}
