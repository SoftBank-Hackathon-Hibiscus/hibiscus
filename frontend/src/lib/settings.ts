import type { SettingsEnvironmentInput } from "../api/types";
export interface SettingsRow {
  name: string;
  value: string;
  stored: boolean;
}
export function prepareSettingsEnvironment(
  rows: SettingsRow[],
): SettingsEnvironmentInput[] {
  if (rows.length > 50) throw new Error("환경변수는 최대 50개입니다.");
  const seen = new Set<string>();
  return rows.map((row) => {
    const name = row.name.trim();
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name))
      throw new Error("환경변수 이름은 영문 대문자·숫자·밑줄을 사용하세요.");
    if (seen.has(name)) throw new Error("같은 환경변수 이름이 있습니다.");
    seen.add(name);
    if (["PORT", "HIB_RUN_ID", "HIB_DIGEST"].includes(name))
      throw new Error(`${name}은 Hibiscus가 관리합니다.`);
    if (row.value.length > 4096)
      throw new Error("환경변수 값은 최대 4096자입니다.");
    if (!row.stored && !row.value)
      throw new Error("새 환경변수의 값을 입력하세요.");
    return { name, ...(row.stored && !row.value ? {} : { value: row.value }) };
  });
}

export function settingsDeploymentRevision(
  deployments: { id: string; sourceRevision: string }[],
  servingDeploymentId?: string,
): string {
  const serving = deployments.find((item) => item.id === servingDeploymentId);
  if (!serving)
    throw new Error(
      "현재 서비스 배포가 없습니다. 새 배포에서 커밋을 선택하세요.",
    );
  return serving.sourceRevision;
}
