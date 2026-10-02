import { ApiError } from '../api/client';
import { Notice } from './ui';

export function describeError(error: unknown): { title: string; detail?: string; unauthorized: boolean } {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) return { title: '토큰이 만료되었습니다. 새 토큰을 입력하세요', detail: error.message, unauthorized: true };
    if (error.status === 0) return { title: '백엔드에 연결할 수 없습니다', detail: error.message, unauthorized: false };
    return { title: `요청 실패 (${error.status})`, detail: error.message, unauthorized: false };
  }
  if (error instanceof Error) return { title: '오류', detail: error.message, unauthorized: false };
  return { title: '오류', detail: String(error), unauthorized: false };
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const { title, detail, unauthorized } = describeError(error);
  return (
    <Notice tone={unauthorized ? 'warning' : 'danger'} title={title}>
      {detail && <span className="mono small">{detail}</span>}
    </Notice>
  );
}
