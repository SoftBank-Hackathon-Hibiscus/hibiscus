import type { StageExecution, StageName } from "../api/types";

export const STAGES: StageName[] = ["test", "policy", "sign", "deploy"];

// 재시도 기록이 모두 남아 있어서 단계마다 attempt 가 가장 큰 행만 사용
export function latestAttempts(stages: StageExecution[]): Partial<Record<StageName, StageExecution>> {
  const latest: Partial<Record<StageName, StageExecution>> = {};
  for (const stage of stages) {
    const current = latest[stage.stage];
    if (!current || stage.attempt > current.attempt) latest[stage.stage] = stage;
  }
  return latest;
}
