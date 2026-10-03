import type { HealthCheckConfig, UpdateHealthCheckInput } from '../api/types';

export interface HealthCheckDraft {
  enabled: boolean;
  path: string;
  versionPath: string;
  method: 'GET' | 'HEAD';
  intervalSeconds: string;
  timeoutSeconds: string;
  successStatusMin: string;
  successStatusMax: string;
  successThreshold: string;
  failureThreshold: string;
}

export type HealthCheckField = Exclude<keyof HealthCheckDraft, 'enabled'>;
export type HealthCheckError = 'required' | 'path' | 'interval' | 'timeout' | 'status' | 'threshold' | 'timeoutOrder' | 'statusOrder';
export type HealthCheckErrors = Partial<Record<HealthCheckField, HealthCheckError>>;

const HTTP_PATH = /^\/(?!\/)[^\s?#]*$/;

export function healthCheckDraft(config: HealthCheckConfig): HealthCheckDraft {
  return {
    enabled: config.enabled,
    path: config.path,
    versionPath: config.versionPath ?? '',
    method: config.method,
    intervalSeconds: String(config.intervalSeconds),
    timeoutSeconds: String(config.timeoutSeconds),
    successStatusMin: String(config.successStatusMin),
    successStatusMax: String(config.successStatusMax),
    successThreshold: String(config.successThreshold),
    failureThreshold: String(config.failureThreshold),
  };
}

function integer(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function validateHealthCheck(draft: HealthCheckDraft): HealthCheckErrors {
  const errors: HealthCheckErrors = {};
  const path = draft.path.trim();
  const versionPath = draft.versionPath.trim();
  if (!path) errors.path = 'required';
  else if (path.length > 256 || !HTTP_PATH.test(path)) errors.path = 'path';
  if (versionPath && (versionPath.length > 256 || !HTTP_PATH.test(versionPath))) errors.versionPath = 'path';

  const interval = integer(draft.intervalSeconds, 1, 300);
  const timeout = integer(draft.timeoutSeconds, 1, 60);
  const statusMin = integer(draft.successStatusMin, 100, 599);
  const statusMax = integer(draft.successStatusMax, 100, 599);
  const successThreshold = integer(draft.successThreshold, 1, 20);
  const failureThreshold = integer(draft.failureThreshold, 1, 20);

  if (interval === null) errors.intervalSeconds = 'interval';
  if (timeout === null) errors.timeoutSeconds = 'timeout';
  else if (interval !== null && timeout > interval) errors.timeoutSeconds = 'timeoutOrder';
  if (statusMin === null) errors.successStatusMin = 'status';
  if (statusMax === null) errors.successStatusMax = 'status';
  else if (statusMin !== null && statusMax < statusMin) errors.successStatusMax = 'statusOrder';
  if (successThreshold === null) errors.successThreshold = 'threshold';
  if (failureThreshold === null) errors.failureThreshold = 'threshold';
  return errors;
}

export function toHealthCheckInput(draft: HealthCheckDraft): UpdateHealthCheckInput {
  return {
    enabled: draft.enabled,
    path: draft.path.trim(),
    version_path: draft.versionPath.trim() || null,
    method: draft.method,
    interval_seconds: Number(draft.intervalSeconds),
    timeout_seconds: Number(draft.timeoutSeconds),
    success_status_min: Number(draft.successStatusMin),
    success_status_max: Number(draft.successStatusMax),
    success_threshold: Number(draft.successThreshold),
    failure_threshold: Number(draft.failureThreshold),
  };
}
