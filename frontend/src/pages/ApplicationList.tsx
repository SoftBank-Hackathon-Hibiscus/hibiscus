import { ChevronRight, Plus } from 'lucide-react';
import type { DataSource } from '../api/client';
import type { ApplicationView } from '../api/types';
import { PageError } from '../components/PageError';
import { PageTitle, Pill, SkeletonCard } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { relTime } from '../lib/format';
import { useLang } from '../lib/i18n';
import { REGISTER_PATH, applicationPath, hrefFor } from '../lib/router';

const POLL_MS = 15000;

/**
 * 앱 목록. GET /applications 하나만 15초마다 읽는다.
 * 현재 트래픽 위치·최근 배포는 앱 상세에서 정확히 보여주므로 여기서 앱마다 추가 호출로 집계하지 않는다.
 */
export function ApplicationList({ source }: { source: DataSource }) {
  const { t, lang } = useLang();
  const poll = usePolling<ApplicationView[]>(() => source.listApplications(), POLL_MS, [source]);
  const apps = poll.data;

  return (
    <div className="page">
      <PageTitle
        title={t('appsTitle')}
        sub={apps ? t('appsCount', { n: apps.length }) : t('appsSubList')}
        right={
          <div className="title-badges">
            <span className="live">
              {t('autoRefresh', { s: POLL_MS / 1000 })}
              {poll.lastUpdated ? ` · ${t('lastChecked', { when: relTime(new Date(poll.lastUpdated).toISOString(), lang) })}` : ''}
            </span>
            <a className="btn btn-primary btn-small" href={hrefFor(REGISTER_PATH)}>
              <Plus size={14} aria-hidden /> {t('registerApp')}
            </a>
          </div>
        }
      />
      {poll.error && !apps ? <PageError error={poll.error} /> : null}
      {poll.error && apps ? <PageError error={poll.error} compact /> : null}
      {poll.loading && !apps && !poll.error && (
        <div className="app-grid" aria-busy="true">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </div>
      )}
      {apps && apps.length === 0 && (
        <section className="card empty-state">
          <h2 className="empty-title">{t('emptyAppsTitle')}</h2>
          <p className="empty-body">{t('emptyAppsBody')}</p>
          <div>
            <a className="btn btn-primary" href={hrefFor(REGISTER_PATH)}>
              <Plus size={14} aria-hidden /> {t('registerApp')}
            </a>
          </div>
        </section>
      )}
      {apps && apps.length > 0 && (
        <ul className="app-grid">
          {apps.map((view) => (
            <li key={view.application.id}>
              <AppCard view={view} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AppCard({ view }: { view: ApplicationView }) {
  const { t } = useLang();
  const a = view.application;
  const agents = view.agents.length;
  return (
    <a className="card app-card" href={hrefFor(applicationPath(a.id))}>
      <span className="app-card-head">
        <span className="app-card-name">{a.name}</span>
        <ChevronRight size={16} className="row-icon app-card-arrow" aria-hidden />
      </span>
      <span className="mono app-card-host">{a.publicHost ?? a.slug}</span>
      <span className="app-card-repo small muted">
        {a.repo ? (
          <>
            {a.repo}
            {a.defaultBranch && <span className="tag">{a.defaultBranch}</span>}
          </>
        ) : (
          t('noRepo')
        )}
      </span>
      <span className="app-card-foot">
        {agents > 0 ? <Pill tone="muted">{t('agentsCount', { n: agents })}</Pill> : <Pill tone="muted">{t('noAgentShort')}</Pill>}
        {a.requiresApproval && <Pill tone="muted">{t('requiresApprovalShort')}</Pill>}
        <span className="app-card-enter">{t('enterApp')}</span>
      </span>
    </a>
  );
}
