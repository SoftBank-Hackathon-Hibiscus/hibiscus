import { ApiError } from '../api/client';
import { translate, useLang, type Lang } from '../lib/i18n';
import { Notice } from './ui';

export function describeError(error: unknown, lang: Lang = 'ko'): { title: string; detail?: string; unauthorized: boolean } {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) return { title: translate(lang, 'tokenExpired'), detail: error.message, unauthorized: true };
    if (error.status === 0) return { title: translate(lang, 'backendUnreachable'), detail: error.message, unauthorized: false };
    return { title: `${translate(lang, 'requestFailed')} (${error.status})`, detail: error.message, unauthorized: false };
  }
  if (error instanceof Error) return { title: translate(lang, 'error'), detail: error.message, unauthorized: false };
  return { title: translate(lang, 'error'), detail: String(error), unauthorized: false };
}

export function ErrorNotice({ error }: { error: unknown }) {
  const { lang } = useLang();
  if (!error) return null;
  const { title, detail, unauthorized } = describeError(error, lang);
  return (
    <Notice tone={unauthorized ? 'warning' : 'danger'} title={title}>
      {detail && <span className="mono small">{detail}</span>}
    </Notice>
  );
}
