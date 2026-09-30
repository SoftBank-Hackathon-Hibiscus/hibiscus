/**
 * 근거 조각에서 비밀처럼 보이는 값을 [REDACTED] 로 가린다.
 * 근거는 plan/pii.json 과 LLM 프롬프트에 실리므로, 소스에 박힌 키가 새지 않게 한다.
 */

const RULES: Array<[RegExp, string]> = [
  // key: "value" / secret = 'value' / password=value / Authorization: value
  // Bearer xxxxx (먼저 처리해야 아래 규칙이 "Bearer" 자체를 값으로 오인하지 않는다)
  [/\bBearer\s+[A-Za-z0-9._\-]+/g, "Bearer [REDACTED]"],
  [/(\b(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|access[_-]?key|private[_-]?key)\b\s*[:=]\s*)(?!bearer\b)(["'`]?)[^"'`\s,;]+\2/gi, "$1$2[REDACTED]$2"],
  // sk-..., pk_..., 같은 접두어형 키
  [/\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_\-]{8,}/g, "[REDACTED]"],
  // .env 스타일: KEY=value (대문자 키)
  [/^(\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*)\S.*$/gm, "$1[REDACTED]"],
  // 아주 긴 토큰 (해시, 서명, base64 등)
  [/[A-Za-z0-9+/=_\-]{32,}/g, "[REDACTED]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
