import { Boxes, ChevronRight, Plus } from 'lucide-react';
import type { DataSource } from '../api/client';
import { ApiError } from '../api/client';
import type { ApplicationView, RouteSnapshot } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Empty, PageTitle, Pill } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { relTime, targetLabel } from '../lib/format';
import { useLang } from '../lib/i18n';
import { REGISTER_PATH, applicationPath, hrefFor } from '../lib/router';

const POLL_MS = 15000;

interface Row {
  view: ApplicationView;
  route: RouteSnapshot | null;
  routeError: unknown;
}

/**
 * 앱 목록. 목록과 각 앱의 현재 route 를 한 번에 모아 15초마다 갱신한다 (행마다 따로 폴링하지 않는다).
 * route 가 없으면(404) "경로 없음". mock 에서도 같은 데이터 계층으로 동작한다.
 */
export function ApplicationList({ source }: { source: DataSource }) {
  const { t } = useLang();
  const poll = usePolling<Row[]>(
    async () => {
      const apps = await source.listApplications();
      const routes = await Promise.allSettled(apps.map((view) => source.getRouting(view.application.id)));
      return apps.map((view, i) => {
        const result = routes[i]!;
        if (result.status === 'fulfilled') return { view, route: result.value, routeError: null };
        const notFound = result.reason instanceof ApiError && result.reason.isNotFound;
        return { view, route: null, routeError: notFound ? null : result.reason };
      });
    },
    POLL_MS,
    [source],
  );

  const rows = poll.data;
  return (
    <div className="page">
      <PageTitle
        title={t('appsTitle')}
        sub={t('appsSub')}
        right={
          <div className="title-badges">
            <span className="live">
              {t('refreshing15s')}
              {poll.lastUpdated ? `, ${relTime(new Date(poll.lastUpdated).toISOString())}` : ''}
            </span>
            <a className="btn btn-primary btn-small" href={hrefFor(REGISTER_PATH)}>
              <Plus size={14} aria-hidden /> {t('registerApp')}
            </a>
          </div>
        }
      />
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      {poll.loading && !rows && <Empty>{t('loading')}</Empty>}
      {rows && rows.length === 0 && (
        <section className="card">
          <div className="stack-sm">
            <Empty>{t('noApps')}</Empty>
            <div>
              <a className="btn btn-primary btn-small" href={hrefFor(REGISTER_PATH)}>
                <Plus size={14} aria-hidden /> {t('registerApp')}
              </a>
            </div>
          </div>
        </section>
      )}
      {rows && rows.length > 0 && (
        <section className="card card-collapsed">
          <ul className="app-rows">
            {rows.map(({ view, route, routeError }) => (
              <li key={view.application.id}>
                <a className="app-row" href={hrefFor(applicationPath(view.application.id))}>
                  <Boxes size={18} className="row-icon" aria-hidden />
                  <span className="app-row-main">
                    <span className="app-row-name">{view.application.name}</span>
                    <span className="small muted mono">{view.application.publicHost ?? view.application.slug}</span>
                  </span>
                  <span className="app-row-meta">
                    {route ? (
                      <>
                        <Pill tone="success">{targetLabel(route.target.kind)}</Pill>
                        <span className="small muted" title={t('routeRevisionHint')}>
                          {t('switchCount')} {route.revision}
                        </span>
                      </>
                    ) : routeError ? (
                      <Pill tone="danger">{t('routeUnknown')}</Pill>
                    ) : (
                      <Pill tone="muted">{t('noRouteShort')}</Pill>
                    )}
                    <ChevronRight size={16} className="row-icon" aria-hidden />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
