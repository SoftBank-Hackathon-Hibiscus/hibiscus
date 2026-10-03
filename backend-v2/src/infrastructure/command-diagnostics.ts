import type { CommandResult } from './command-runner.js';
import { stripVTControlCharacters } from 'node:util';

/** Only bounded, redacted output is persisted in deployment stage summaries. */
export function diagnosticTail(output: string): string {
  // Strip terminal escapes before applying redaction, not afterwards.
  const redacted = stripVTControlCharacters(output)
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
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
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
) {
  return {
    stub: false,
    command_phase: phase,
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timedOut,
    stdout_tail: diagnosticTail(result.stdout),
    stderr_tail: diagnosticTail(result.stderr),
    output_truncated: result.outputTruncated ?? false,
  };
}
