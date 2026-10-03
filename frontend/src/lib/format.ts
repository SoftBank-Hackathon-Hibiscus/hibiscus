export function shortHash(value: string | null | undefined, length = 12): string {
  if (!value) return '—';
  const body = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (body.length <= length) return value;
  return (value.startsWith('sha256:') ? 'sha256:' : '') + body.slice(0, length) + '…';
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type Lang = 'ko' | 'ja';

/** "방금 / n초 전 / n분 전 …". 선택한 언어로 쓴다. */
export function relTime(iso: string | null | undefined, lang: Lang = 'ko', now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  const ja = lang === 'ja';
  if (Math.abs(diff) < 5) return ja ? 'たった今' : '방금';
  if (diff < 60) return ja ? `${diff}秒前` : `${diff}초 전`;
  if (diff < 3600) return ja ? `${Math.floor(diff / 60)}分前` : `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return ja ? `${Math.floor(diff / 3600)}時間前` : `${Math.floor(diff / 3600)}시간 전`;
  return ja ? `${Math.floor(diff / 86400)}日前` : `${Math.floor(diff / 86400)}일 전`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined, lang: Lang = 'ko'): string {
  if (!start || !end) return '—';
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  const ja = lang === 'ja';
  if (s < 60) return ja ? `${s}秒` : `${s}초`;
  return ja ? `${Math.floor(s / 60)}分 ${s % 60}秒` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

export function targetLabel(kind: string | null | undefined): string {
  if (kind === 'onprem') return 'On-Prem';
  if (kind === 'cloud_run') return 'Cloud Run';
  return kind ?? '—';
}

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
