/** 환경변수 → 설정. 비밀값은 여기서 읽지 않고 각 CLI 가 자기 환경변수로 읽는다 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type SignerMode = "dry" | "real";
export type DeployMode = "off" | "dry" | "real";

export interface Config {
  /** bind 주소. 기본 127.0.0.1 (webhook·인증이 붙기 전에는 외부 공개용이 아님) */
  host: string;
  port: number;
  /** 실행 산출물 폴더 (절대 경로) */
  workDir: string;
  /** 레포 루트 (절대 경로). policy/, signer/, 앱 로컬 경로의 기준 */
  repoRoot: string;
  policyDir: string;
  signerDir: string;
  /** 루트 contracts/ (Plan, SignResult 스키마) */
  contractsDir: string;
  /** 테스트 stub 템플릿 폴더 */
  templatesDir: string;
  signerMode: SignerMode;
  deployMode: DeployMode;
  policyTimeoutMs: number;
  signerTimeoutMs: number;
}

export class ConfigError extends Error {}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], name: string, fallback: T): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${name} 는 ${allowed.join(" | ")} 중 하나여야 합니다: ${value}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, backendRoot: string = BACKEND_ROOT): Config {
  const repoRoot = resolve(env.REPO_ROOT || resolve(backendRoot, ".."));
  const workDir = resolve(env.WORK_DIR || resolve(backendRoot, ".work"));
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError(`PORT 가 올바르지 않습니다: ${env.PORT}`);
  return {
    host: env.HOST || "127.0.0.1",
    port,
    workDir,
    repoRoot,
    policyDir: resolve(repoRoot, "policy"),
    signerDir: resolve(repoRoot, "signer"),
    contractsDir: resolve(repoRoot, "contracts"),
    templatesDir: resolve(backendRoot, "fixtures", "test-templates"),
    signerMode: pick(env.SIGNER_MODE, ["dry", "real"] as const, "SIGNER_MODE", "dry"),
    deployMode: pick(env.DEPLOY_MODE, ["off", "dry", "real"] as const, "DEPLOY_MODE", "off"),
    policyTimeoutMs: 180_000,
    signerTimeoutMs: 180_000,
  };
}
