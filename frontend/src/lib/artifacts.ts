import type { DeploymentArtifact } from "../api/types";

export interface ParsedArtifact<T> {
  artifact: DeploymentArtifact | null;
  data: T | null;
  error: string | null;
}

// 같은 이름이 여러 번이면(재시도) 최신 시도의 것. stageExecutionIds 를 주면 그 시도 것만
export function pickArtifact(
  artifacts: DeploymentArtifact[],
  name: string,
  stageExecutionIds?: string[],
): DeploymentArtifact | null {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.name === name &&
      (!stageExecutionIds || stageExecutionIds.includes(artifact.stageExecutionId)),
  );
  // 서버가 sequence, attempt 순으로 정렬해서 주므로 마지막이 최신
  return matches.at(-1) ?? null;
}

export function parseArtifact<T>(
  artifacts: DeploymentArtifact[],
  name: string,
  stageExecutionIds?: string[],
): ParsedArtifact<T> {
  const artifact = pickArtifact(artifacts, name, stageExecutionIds);
  if (!artifact) return { artifact: null, data: null, error: null };
  try {
    return { artifact, data: JSON.parse(artifact.content) as T, error: artifact.validationError };
  } catch {
    return { artifact, data: null, error: artifact.validationError ?? "JSON 형식이 아님" };
  }
}
