import { ChevronRight, FlaskConical, Lock, Plus, Rocket, Scale, type LucideIcon } from 'lucide-react';
import type { DataSource } from '../api/client';
import type { ApplicationView } from '../api/types';
import { PageError } from '../components/PageError';
import { Notice, Pill, SkeletonCard } from '../components/ui';
import type { ConnectionState } from '../hooks/useConnection';
import { usePolling } from '../hooks/usePolling';
import { useLang, type DictKey } from '../lib/i18n';
import { APPLICATIONS_PATH, CONNECT_PATH, DEMOS_PATH, REGISTER_PATH, applicationPath, realHref } from '../lib/router';

interface FlowStep {
  icon: LucideIcon;
  title: DictKey;
  line: DictKey;
}

const FLOW: FlowStep[] = [
  { icon: FlaskConical, title: 'flowTestTitle', line: 'flowTestLine' },
  { icon: Scale, title: 'flowPolicyTitle', line: 'flowPolicyLine' },
  { icon: Lock, title: 'flowSignTitle', line: 'flowSignLine' },
  { icon: Rocket, title: 'flowDeployTitle', line: 'flowDeployLine' },
];

/** 홈에 보여줄 앱 수. 더 있으면 "모두 보기" */
const OVERVIEW_LIMIT = 6;

/**
 * 서비스 홈. 한 줄 설명 + 애플리케이션 보기(primary) + 데모 보기(secondary),
 * 로그인돼 있으면 등록된 애플리케이션 일부, 아래에 작은 배포 흐름 strip.
 * 데모 모드로 들어왔을 때는 실제 데이터를 섞지 않고 데모임을 알리는 카드만 둔다.
 */
export function Home({ source, isReal, connection }: { source: DataSource; isReal: boolean; connection: ConnectionState }) {
  const { t } = useLang();
  const signedIn = isReal && connection.level === 'ok';
  const appsHref = realHref(signedIn ? APPLICATIONS_PATH : CONNECT_PATH);

  return (
    <div className="page home">
      <header className="home-head">
        <h1 className="home-title">{t('homeTitle')}</h1>
        <p className="home-sub">{t('homeSub')}</p>
        <div className="home-cta">
          <a className="btn btn-primary" href={appsHref}>
            {t('homeCtaApps')}
          </a>
          <a className="btn btn-ghost" href={realHref(DEMOS_PATH)}>
            {t('homeCtaDemo')}
          </a>
        </div>
      </header>

      {isReal && connection.level === 'down' && (
        <Notice tone="danger" title={t('errOfflineTitle')}>
          {t('errOfflineBody')} <a href={realHref(CONNECT_PATH)}>{t('checkConnection')}</a>
        </Notice>
      )}

      {!isReal && (
        <section className="card demo-mode">
          <div className="row">
            <Pill tone="warning">DEMO</Pill>
            <strong>{t('demoModeTitle')}</strong>
          </div>
          <p className="small muted">{t('demoModeBody')}</p>
          <div className="row">
            <a className="btn btn-small" href={realHref(DEMOS_PATH)}>
              {t('demosTitle')}
            </a>
            <a className="btn btn-small btn-ghost" href={realHref(APPLICATIONS_PATH)}>
              {t('backToService')}
            </a>
          </div>
        </section>
      )}

      {signedIn && <AppsOverview source={source} />}

      {isReal && !signedIn && connection.level !== 'down' && connection.level !== 'checking' && (
        <section className="card signin-card">
          <h2 className="empty-title">{t('signinCardTitle')}</h2>
          <p className="empty-body">{t('signinCardBody')}</p>
          <div>
            <a className="btn btn-primary" href={realHref(CONNECT_PATH)}>
              {t('loginAction')}
            </a>
          </div>
        </section>
      )}

      <section className="flow-strip" aria-label={t('flowStripTitle')}>
        <h2 className="flow-strip-title">{t('flowStripTitle')}</h2>
        <ol className="flow-track">
          {FLOW.map(({ icon: Icon, title, line }) => (
            <li key={title} className="flow-item">
              <span className="flow-mark" aria-hidden>
                <Icon size={15} />
              </span>
              <span className="flow-title">{t(title)}</span>
              <span className="flow-line">{t(line)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** GET /applications 한 번. API 가 확실히 주는 값만: 이름, public host, repo/branch, 에이전트 유무. */
function AppsOverview({ source }: { source: DataSource }) {
  const { t } = useLang();
  const poll = usePolling<ApplicationView[]>(() => source.listApplications(), null, [source]);
  const apps = poll.data;
  const sorted = apps ? [...apps].sort((a, b) => Date.parse(b.application.updatedAt) - Date.parse(a.application.updatedAt)) : null;
  const shown = sorted ? sorted.slice(0, OVERVIEW_LIMIT) : null;

  return (
    <section className="overview">
      <div className="overview-head">
        <h2>{t('appsTitle')}</h2>
        {apps && apps.length > 0 && (
          <a className="overview-all" href={realHref(APPLICATIONS_PATH)}>
            {apps.length > OVERVIEW_LIMIT ? t('seeAllCount', { n: apps.length }) : t('seeAll')}
          </a>
        )}
      </div>
      {poll.error !== null && !apps ? <PageError error={poll.error} compact /> : null}
      {poll.loading && !apps && !poll.error && (
        <div className="card overview-card" aria-busy="true">
          <SkeletonCard lines={2} title={false} />
        </div>
      )}
      {apps && apps.length === 0 && (
        <section className="card empty-state">
          <h2 className="empty-title">{t('emptyAppsTitle')}</h2>
          <p className="empty-body">{t('emptyAppsBody')}</p>
          <div>
            <a className="btn btn-primary" href={realHref(REGISTER_PATH)}>
              <Plus size={14} aria-hidden /> {t('registerApp')}
            </a>
          </div>
        </section>
      )}
      {shown && shown.length > 0 && (
        <ul className="card card-collapsed overview-list">
          {shown.map((view) => {
            const a = view.application;
            return (
              <li key={a.id}>
                <a className="overview-row" href={realHref(applicationPath(a.id))}>
                  <span className="overview-main">
                    <span className="overview-name">{a.name}</span>
                    <span className="mono small muted">{a.publicHost ?? a.slug}</span>
                  </span>
                  <span className="overview-meta small muted">
                    {a.repo ? (
                      <span className="overview-repo">
                        {a.repo}
                        {a.defaultBranch && <span className="tag">{a.defaultBranch}</span>}
                      </span>
                    ) : (
                      <span>{t('noRepo')}</span>
                    )}
                    <Pill tone="muted">{view.agents.length > 0 ? t('agentsCount', { n: view.agents.length }) : t('noAgentShort')}</Pill>
                  </span>
                  <ChevronRight size={16} className="row-icon" aria-hidden />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
