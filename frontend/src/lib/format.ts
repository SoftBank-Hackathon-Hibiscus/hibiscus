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

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((now - t) / 1000);
  if (Math.abs(diff) < 5) return '방금';
  if (diff < 60) return `${diff}초 전`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—';
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  return `${Math.floor(s / 60)}분 ${s % 60}초`;
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
