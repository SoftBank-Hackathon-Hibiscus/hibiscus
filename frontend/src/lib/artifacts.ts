import type { DeploymentArtifact, DeploymentView, StageExecution, StageName } from '../api/types';

export const STAGE_ORDER: StageName[] = ['test', 'policy', 'sign', 'deploy'];

/** 단계별 최신 시도만 고른다 (attempt 가 큰 row). */
export function latestStages(stages: StageExecution[]): Partial<Record<StageName, StageExecution>> {
  const out: Partial<Record<StageName, StageExecution>> = {};
  for (const s of stages) {
    const current = out[s.stage];
    if (!current || s.attempt > current.attempt) out[s.stage] = s;
  }
  return out;
}

/**
 * 산출물을 name 으로 고른다. 같은 이름이 여러 단계에 있을 수 있으므로(test_result 는 test 와 policy 둘 다)
 * 단계 실행 id 가 주어지면 그 단계 것을 우선하고, 없으면 마지막 것을 쓴다.
 */
export function findArtifact(view: DeploymentView, name: string, stage?: StageExecution): DeploymentArtifact | undefined {
  const matches = view.artifacts.filter((a) => a.name === name);
  if (stage) {
    const own = matches.find((a) => a.stageExecutionId === stage.id);
    if (own) return own;
    const byId = stage.artifacts[name];
    if (byId) {
      const linked = view.artifacts.find((a) => a.id === byId);
      if (linked) return linked;
    }
  }
  return matches[matches.length - 1];
}

export type Parsed<T> = { ok: true; value: T; artifact: DeploymentArtifact } | { ok: false; raw: string; artifact: DeploymentArtifact; error: string };

/**
 * JSON 산출물만 parse 한다. text/plain 이거나 parse 실패면 raw 를 돌려준다.
 * 서버가 `validationError` 를 남긴 산출물(run_id·digest 불일치 등)은 JSON 이 멀쩡해도 증거로 쓰지 않는다:
 * ok:false 로 돌려주고 원문은 raw 로 남긴다 (세부 기술 정보에서만 보인다).
 */
export function parseJsonArtifact<T>(artifact: DeploymentArtifact | undefined): Parsed<T> | undefined {
  if (!artifact) return undefined;
  if (artifact.validationError) {
    return { ok: false, raw: artifact.content, artifact, error: artifact.validationError };
  }
  if (artifact.mediaType !== 'application/json') {
    return { ok: false, raw: artifact.content, artifact, error: `${artifact.mediaType} 산출물은 parse 하지 않음` };
  }
  try {
    return { ok: true, value: JSON.parse(artifact.content) as T, artifact };
  } catch (error) {
    return { ok: false, raw: artifact.content, artifact, error: (error as Error).message };
  }
}

export function artifactsOf(view: DeploymentView, stage: StageExecution | undefined): DeploymentArtifact[] {
  if (!stage) return [];
  return view.artifacts.filter((a) => a.stageExecutionId === stage.id);
}
