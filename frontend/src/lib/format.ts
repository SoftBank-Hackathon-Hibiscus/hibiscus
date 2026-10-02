import type { User } from "../api/types";

export const short = (value: string | null | undefined, length: number) =>
  value ? value.slice(0, length) : "-";

// sha256: 접두어를 빼고 앞 12자
export const shortDigest = (digest: string | null | undefined) =>
  digest ? digest.replace(/^sha256:/, "").slice(0, 12) : "-";

export function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "-";
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (Number.isNaN(seconds)) return value;
  if (seconds < 5) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

export const TARGET_LABEL: Record<string, string> = {
  onprem: "On-Prem",
  cloud_run: "Cloud Run",
};

export const targetLabel = (kind: string | null | undefined) =>
  kind ? (TARGET_LABEL[kind] ?? kind) : "-";

// 서버는 요청자·승인자를 User id 로만 줌. 다른 사람 login 을 찾는 API 는 없음
export function personLabel(id: string | null, me: User | undefined): string {
  if (!id) return "-";
  if (id === "auto") return "auto (자동)";
  if (me && id === me.id) return `나 (${me.login})`;
  return short(id, 8);
}
