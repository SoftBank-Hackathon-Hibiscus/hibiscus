// 등록·배포 입력 검증. backend-v2 DTO(origin/main) 와 같은 규칙을 화면에서 먼저 적용한다.
//  - CreateApplicationDto / GithubApplicationDto (application.dto.ts, github.dto.ts)
//  - CreateDeploymentDto (deployment.dto.ts)
import type { ApplicationEnvironmentVariableInput, CreateDeploymentInput, GithubApplicationCreated, GithubApplicationInput } from '../api/types';
import { applicationPath, deploymentPath } from './router';
import type { DictKey } from './i18n';

/** CreateApplicationDto.slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ , MaxLength(64) */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** CreateDeploymentDto.source_revision: /^[0-9a-f]{7,40}$/ */
export const SOURCE_REVISION_RE = /^[0-9a-f]{7,40}$/;
/**
 * 전체 커밋 SHA. DTO 는 7–40자리를 받지만 registry parity 테스트 단계(parity-test.stage.ts)와
 * GitHub checkout(github-source-checkout.service.ts)은 40자리가 아니면 실패한다.
 */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** parity-test.stage.ts isGithubSource 와 같은 규칙. 이 sourcePath 의 앱은 테스트 단계가 커밋을 GitHub 에서 checkout 한다 */
export const GITHUB_SOURCE_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

export function isGithubSource(sourcePath: string): boolean {
  return GITHUB_SOURCE_RE.test(sourcePath);
}
/** CreateDeploymentDto.image_digest: /^sha256:[0-9a-f]{64}$/ */
export const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export const NAME_MAX = 64;
export const SLUG_MAX = 64;
export const BRANCH_MAX = 255;
export const PORT_MIN = 1;
export const PORT_MAX = 65_535;
export const DEFAULT_CONTAINER_PORT = 8080;
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const ENV_MAX_COUNT = 50;
export const ENV_VALUE_MAX = 4096;
export const RESERVED_ENV_NAMES = new Set(['PORT', 'HIB_RUN_ID', 'HIB_DIGEST']);

export type TestTemplate = 'allow' | 'block-test-failed';

/** 화면 입력 상태. 숫자 입력은 문자열로 들고 있다가 검증 때 바꾼다. */
export interface RegistrationDraft {
  installationId: number | null;
  repositoryId: number | null;
  branch: string;
  name: string;
  slug: string;
  imageRepo: string;
  containerPort: string;
  testTemplate: TestTemplate;
  requiresApproval: boolean;
  autoDeploy: boolean;
  environment: ApplicationEnvironmentVariableInput[];
  testEnvironment: ApplicationEnvironmentVariableInput[];
}

export const EMPTY_REGISTRATION: RegistrationDraft = {
  installationId: null,
  repositoryId: null,
  branch: '',
  name: '',
  slug: '',
  imageRepo: '',
  containerPort: String(DEFAULT_CONTAINER_PORT),
  testTemplate: 'allow',
  requiresApproval: false,
  autoDeploy: true,
  environment: [],
  testEnvironment: [],
};

export type RegistrationField = keyof RegistrationDraft;
export type RegistrationErrors = Partial<Record<RegistrationField, DictKey>>;

/** 저장소 이름에서 slug 후보를 만든다 (소문자, 영숫자 외는 '-', 앞뒤·연속 '-' 정리, 64자) */
export function slugify(source: string): string {
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

/** "owner/repo" 에서 repo 부분 */
export function repoShortName(fullName: string): string {
  const idx = fullName.indexOf('/');
  return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : null;
}

export function validateRegistration(d: RegistrationDraft): RegistrationErrors {
  const errors: RegistrationErrors = {};
  if (d.installationId === null) errors.installationId = 'errInstallation';
  if (d.repositoryId === null) errors.repositoryId = 'errRepository';
  if (!d.branch.trim()) errors.branch = 'errBranch';
  else if (d.branch.length > BRANCH_MAX) errors.branch = 'errBranchLong';

  const name = d.name.trim();
  if (!name) errors.name = 'errNameRequired';
  else if (name.length > NAME_MAX) errors.name = 'errNameLong';

  if (!SLUG_RE.test(d.slug) || d.slug.length > SLUG_MAX) errors.slug = 'errSlug';

  if (!d.imageRepo.trim()) errors.imageRepo = 'errImageRepo';

  const port = parsePort(d.containerPort);
  if (port === null || port < PORT_MIN || port > PORT_MAX) errors.containerPort = 'errPort';

  if (validateEnvironment(d.environment) !== null) errors.environment = 'errEnvironment';
  if (validateEnvironment(d.testEnvironment) !== null) errors.testEnvironment = 'errEnvironment';

  return errors;
}

/**
 * GithubApplicationDto 키만 담아 보낸다 (backend 는 forbidNonWhitelisted).
 * source_path 는 DTO 기본값 'github' 이고 repo / default_branch / public_host / health_check 는 backend 가 채우므로 보내지 않는다.
 */
export function toGithubApplicationInput(d: RegistrationDraft): GithubApplicationInput {
  const input: GithubApplicationInput = {
    name: d.name.trim(),
    slug: d.slug,
    image_repo: d.imageRepo.trim(),
    container_port: Number(d.containerPort.trim()),
    test_template: d.testTemplate,
    requires_approval: d.requiresApproval,
    installation_id: d.installationId ?? 0,
    repository_id: d.repositoryId ?? 0,
    branch: d.branch,
    auto_deploy: d.autoDeploy,
    environment: normalizeEnvironment(d.environment),
    test_environment: normalizeEnvironment(d.testEnvironment),
  };
  return input;
}

export function normalizeEnvironment(environment: ApplicationEnvironmentVariableInput[]): ApplicationEnvironmentVariableInput[] {
  return environment.map(({ name, value }) => ({ name: name.trim(), value }));
}

/** Backend ApplicationEnvironmentVariableDto 및 서비스 검증과 같은 규칙. */
export function validateEnvironment(environment: ApplicationEnvironmentVariableInput[]): 'count' | 'name' | 'duplicate' | 'reserved' | 'value' | null {
  if (environment.length > ENV_MAX_COUNT) return 'count';
  const names = environment.map(({ name }) => name.trim());
  if (names.some((name) => !ENV_NAME_RE.test(name))) return 'name';
  if (new Set(names).size !== names.length) return 'duplicate';
  if (names.some((name) => RESERVED_ENV_NAMES.has(name))) return 'reserved';
  if (environment.some(({ value }) => value.length > ENV_VALUE_MAX)) return 'value';
  return null;
}

/** 등록 직후 갈 곳. backend 가 만든 최초 배포가 있으면 그 진행(테스트 → 정책 → 서명 → 배포)을 바로 보여 주고, 없으면 앱 상세 */
export function registeredPath(created: GithubApplicationCreated): string {
  return created.initial_deployment ? deploymentPath(created.initial_deployment.id) : applicationPath(created.application.id);
}

// ---------------------------------------------------------------- 새 배포

export interface DeploymentDraft {
  sourceRevision: string;
  imageDigest: string;
}

export type DeploymentErrors = Partial<Record<keyof DeploymentDraft, DictKey>>;

/** requireFullSha: GitHub 저장소 앱이면 true. 40자리 전체 SHA 만 받는다 */
export function validateDeployment(d: DeploymentDraft, { requireFullSha = false }: { requireFullSha?: boolean } = {}): DeploymentErrors {
  const errors: DeploymentErrors = {};
  const revision = d.sourceRevision.trim();
  if (requireFullSha ? !FULL_SHA_RE.test(revision) : !SOURCE_REVISION_RE.test(revision)) errors.sourceRevision = requireFullSha ? 'errSourceRevisionFull' : 'errSourceRevision';
  const digest = d.imageDigest.trim();
  if (digest && !IMAGE_DIGEST_RE.test(digest)) errors.imageDigest = 'errImageDigest';
  return errors;
}

/** CreateDeploymentDto 키만. image_digest 는 비어 있으면 보내지 않는다 (backend 가 placeholder digest 를 만든다). */
export function toCreateDeploymentInput(d: DeploymentDraft): CreateDeploymentInput {
  const input: CreateDeploymentInput = { source_revision: d.sourceRevision.trim() };
  const digest = d.imageDigest.trim();
  if (digest) input.image_digest = digest;
  return input;
}

// ---------------------------------------------------------------- backend 오류 메시지

/** backend 가 던지는 고정 메시지를 사람이 읽는 안내로. 모르는 메시지는 null (원문 그대로 보여준다). */
export function friendlyBackendError(message: string): DictKey | null {
  switch (message) {
    case 'Application slug already exists':
    case 'Application public host already exists':
      return 'beSlugTaken';
    case 'Repository is not accessible':
    case 'GitHub resource is not accessible':
      return 'beRepoNotAccessible';
    case 'GitHub login is required':
    case 'GitHub account must be reconnected':
    case 'GitHub connection expired; log in again':
    case 'Cannot read GitHub credentials; log in again':
    case 'GitHub authorization is required':
      return 'beGithubReconnect';
    case 'GitHub API request failed':
    case 'Cannot connect to GitHub':
    case 'GitHub token refresh failed':
    case 'GitHub branch response does not match':
      return 'beGithubUnavailable';
    case 'Application not found':
      return 'beAppNotFound';
    default:
      return null;
  }
}
