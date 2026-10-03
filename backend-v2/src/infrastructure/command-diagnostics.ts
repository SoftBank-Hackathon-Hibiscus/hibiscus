import type { CommandResult } from './command-runner.js';
import { stripVTControlCharacters } from 'node:util';

/** Only bounded, redacted output is persisted in deployment stage summaries. */
export function diagnosticTail(output: string, secrets: string[] = []): string {
  // Strip terminal escapes before applying redaction, not afterwards.
  const redacted = redactDeploymentOutput(
    stripVTControlCharacters(output),
    secrets,
  )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s,;"']+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)|pwd|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
      '[REDACTED]',
    )
    .replace(/\r\n?/g, '\n');
  // Redact first: slicing before this can expose the middle of a credential.
  return redacted.trimEnd().split('\n').slice(-20).join('\n').slice(-4000);
}

export function commandDiagnostics(
  phase: 'checkout' | 'build' | 'test',
  result: CommandResult,
  secrets: string[] = [],
) {
  return {
    stub: false,
    command_phase: phase,
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timedOut,
    stdout_tail: diagnosticTail(result.stdout, secrets),
    stderr_tail: diagnosticTail(result.stderr, secrets),
    output_truncated: result.outputTruncated ?? false,
  };
}

/** Returns a redacted copy; signed artifacts and their hashes remain unchanged in storage. */
export function redactDeploymentOutput<T>(value: T, secrets: string[]): T {
  const replacements = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let text = stripVTControlCharacters(item);
      for (const secret of replacements)
        text = text.split(secret).join('[REDACTED]');
      return text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          visit(key) as string,
          visit(child),
        ]),
      );
    return item;
  };
  return visit(value) as T;
}

/** Protect output fields without changing deployment IDs, revisions or artifact hashes. */
export function redactDeploymentView<T>(value: T, secrets: string[]): T {
  const outputFields = new Set([
    'summary',
    'error',
    'content',
    'payload',
    'validationError',
  ]);
  const content = (item: unknown): unknown => {
    if (typeof item !== 'string') return redactDeploymentOutput(item, secrets);
    try {
      const parsed: unknown = JSON.parse(item);
      const redacted = redactDeploymentOutput(parsed, secrets);
      return JSON.stringify(parsed) === JSON.stringify(redacted)
        ? item
        : JSON.stringify(redacted);
    } catch {
      return redactDeploymentOutput(item, secrets);
    }
  };
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          key === 'content'
            ? content(child)
            : outputFields.has(key)
              ? redactDeploymentOutput(child, secrets)
              : visit(child),
        ]),
      );
    return item;
  };
  return visit(value) as T;
}
