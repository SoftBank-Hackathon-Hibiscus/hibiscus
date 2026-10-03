import { ApiError } from '../api/client';
import { useLang } from '../lib/i18n';
import { APPLICATIONS_PATH, CONNECT_PATH, HOME_PATH, hrefFor } from '../lib/router';
import { Notice } from './ui';

/**
 * 화면 하나를 통째로 못 그릴 때의 오류. 사람 말로 무슨 일인지와 다음 행동을 알려 준다.
 * compact 는 이미 데이터가 있는 화면 위에 띄우는 작은 알림 (이전 데이터는 유지).
 */
export function PageError({ error, compact = false }: { error: unknown; compact?: boolean }) {
  const { t } = useLang();
  const status = error instanceof ApiError ? error.status : null;
  const detail = error instanceof Error ? error.message : String(error);

  let title = t('errLoadTitle');
  let body = t('errLoadBody');
  let action: { href: string; label: string } | null = null;
  if (status === 404) {
    title = t('errNotFoundTitle');
    body = t('errNotFoundBody');
    action = { href: hrefFor(APPLICATIONS_PATH), label: t('appsTitle') };
  } else if (status === 401 || status === 403) {
    title = status === 403 ? t('authForbidden') : t('errLoginTitle');
    body = status === 403 ? '' : t('errLoginBody');
    action = { href: hrefFor(CONNECT_PATH), label: t('connectLink') };
  } else if (status === 0) {
    title = t('errOfflineTitle');
    body = t('errOfflineBody');
    action = { href: hrefFor(CONNECT_PATH), label: t('connectLink') };
  } else if (status === null) {
    action = { href: hrefFor(HOME_PATH), label: t('navHome') };
  }

  if (compact) {
    return (
      <Notice tone={status === 401 || status === 403 ? 'warning' : 'danger'} title={title}>
        {body && <span>{body} </span>}
        <span className="mono small">{detail}</span>
      </Notice>
    );
  }
  return (
    <section className="card error-state" role="alert">
      <h2 className="empty-title">{title}</h2>
      {body && <p className="empty-body">{body}</p>}
      {detail && <p className="mono small muted">{detail}</p>}
      {action && (
        <div>
          <a className="btn" href={action.href}>
            {action.label}
          </a>
        </div>
      )}
    </section>
  );
}
