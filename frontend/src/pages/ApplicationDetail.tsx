import { ArrowRight, Check, ChevronRight, Clock, Cloud, LoaderCircle, Minus, Plus, Server, ShieldX, Shuffle, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type DataSource } from '../api/client';
import { MockDataSource } from '../api/mock';
import type { AgentStatusResponse, ApplicationAgentSummary, ApplicationView, Deployment, DeploymentStatus, PolicyResult, RouteSnapshot, RoutingTargetHealth, RoutingTargetView, TargetKind } from '../api/types';
import { ErrorNotice, describeError } from '../components/ErrorNotice';
import { NewDeploymentModal } from '../components/NewDeploymentModal';
import { PageError } from '../components/PageError';
import { Crumbs, Empty, Hash, PageSkeleton, PageTitle, Pill, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { detectRouteChange, markOf, type RouteChange, type RouteMark } from '../lib/failover';
import { fmtTime, relTime, targetLabel } from '../lib/format';
import { useLang, type DictKey } from '../lib/i18n';
import { APPLICATIONS_PATH, deploymentPath, hrefFor, realHref } from '../lib/router';

const POLL_MS = 5000;

interface AgentRow {
  agent: ApplicationAgentSummary;
  status: AgentStatusResponse | null;
  error: unknown;
}

interface Snapshot {
  app: ApplicationView;
  route: RouteSnapshot | null;
  targets: RoutingTargetView[];
  deployments: Deployment[];
  agents: AgentRow[];
  routePolicy: PolicyResult | null;
  routePolicyError: unknown;
  fetchedAt: number;
}

interface SeenChange {
  at: number;
  change: RouteChange;
}

const STATUS_TONE: Record<DeploymentStatus, Tone> = { queued: 'info', running: 'info', awaiting_approval: 'warning', blocked: 'danger', failed: 'danger', succeeded: 'success' };
/** 색만으로 구분되지 않게 상태마다 다른 모양. 차단(방패)과 실패(X)는 같은 빨강이라 특히 중요. */
const STATUS_ICON: Record<DeploymentStatus, LucideIcon> = { queued: Minus, running: LoaderCircle, awaiting_approval: Clock, blocked: ShieldX, failed: X, succeeded: Check };
const STATUS_KEY: Record<DeploymentStatus, DictKey> = { queued: 'statusQueued', running: 'statusRunning', awaiting_approval: 'statusAwaiting', blocked: 'statusBlocked', failed: 'statusFailed', succeeded: 'statusSucceeded' };
const HEALTH_KEY: Record<string, DictKey> = { healthy: 'healthy', unhealthy: 'unhealthy', unknown: 'unknown' };

function healthTone(status: string | undefined): Tone {
  if (status === 'healthy') return 'success';
  if (status === 'unhealthy') return 'danger';
  return 'muted';
}

/** expiresAt 이 지난 관측은 unknown 으로 본다 (routing.service 와 같은 규칙) */
function effectiveStatus(health: RoutingTargetHealth | null): { status: string | undefined; expired: boolean } {
  if (!health) return { status: undefined, expired: false };
  const expired = Date.parse(health.expiresAt) < Date.now();
  return { status: expired ? 'unknown' : health.status, expired };
}

export function ApplicationDetail({ id, source }: { id: string; source: DataSource }) {
  const { t, lang } = useLang();
  const policyCache = useRef(new Map<string, PolicyResult | null>());

  const poll = usePolling<Snapshot>(
    async () => {
      const app = await source.getApplication(id);
      const [route, targets, deployments] = await Promise.all([
        source.getRouting(id).catch((error: unknown) => {
          if (error instanceof ApiError && error.isNotFound) return null;
          throw error;
        }),
        source.getTargets(id),
        source.listDeployments(id),
      ]);
      const agents: AgentRow[] = app.agents.length
        ? await Promise.all(
            app.agents.map((agent) =>
              source
                .getAgentStatus(agent.id)
                .then((status) => ({ agent, status, error: null }))
                .catch((error: unknown) => ({ agent, status: null, error })),
            ),
          )
        : [];
      let routePolicy: PolicyResult | null = null;
      let routePolicyError: unknown = null;
      if (route) {
        const depId = route.target.deploymentId;
        if (policyCache.current.has(depId)) routePolicy = policyCache.current.get(depId) ?? null;
        else {
          try {
            const view = await source.getDeployment(depId);
            routePolicy = view.policyResult;
            policyCache.current.set(depId, routePolicy);
          } catch (error) {
            routePolicyError = error;
          }
        }
      }
      return { app, route, targets, deployments, agents, routePolicy, routePolicyError, fetchedAt: Date.now() };
    },
    POLL_MS,
    [id, source],
  );

  // route 변화 감지는 lib/failover.ts 의 순수 함수. 첫 관측·같은 revision·route 사라짐은 변화로 치지 않는다.
  const [events, setEvents] = useState<SeenChange[]>([]);
  const [deployOpen, setDeployOpen] = useState(false);
  const previousRoute = useRef<RouteMark | null>(null);
  useEffect(() => {
    if (!poll.data) return;
    const current = markOf(poll.data.route);
    const change = detectRouteChange(previousRoute.current, current);
    if (change) setEvents((list) => [...list, { at: poll.data!.fetchedAt, change }]);
    if (current) previousRoute.current = current;
  }, [poll.data]);

  const snap = poll.data;
  if (poll.loading && !snap) return <PageSkeleton cards={3} />;
  if (!snap) return <PageError error={poll.error ?? new Error('no data')} />;

  const a = snap.app.application;
  const h = snap.app.healthCheck;
  const route = snap.route;
  const latestEvent = events[events.length - 1];
  const failedOver = Boolean(latestEvent?.change.failover);
  const onpremUnhealthy = snap.targets.some((x) => x.target.kind === 'onprem' && x.health?.status === 'unhealthy');
  const degraded = Boolean(route && route.target.kind === 'cloud_run' && (failedOver || onpremUnhealthy));
  const mockCaption = source instanceof MockDataSource ? source.frameCaption() : null;
  const headline = !route ? t('noRouteNote') : degraded ? t('trafficFailedOver') : t('trafficOn', { target: targetLabel(route.target.kind) });
  const headlineTone: Tone = !route ? 'muted' : degraded ? 'warning' : 'success';

  return (
    <div className="page">
      {poll.error ? <PageError error={poll.error} compact /> : null}
      <PageTitle
        crumbs={<Crumbs items={[{ label: t('crumbApps'), href: realHref(APPLICATIONS_PATH) }, { label: a.name }]} />}
        title={a.name}
        sub={
          <span key={headline} className={`headline headline-${headlineTone}`}>
            <span className="headline-dot" aria-hidden />
            {headline}
          </span>
        }
        right={
          <div className="title-badges">
            {a.publicHost && <span className="mono muted small">{a.publicHost}</span>}
            <span className="live">
              {t('autoRefresh', { s: POLL_MS / 1000 })}
              {poll.lastUpdated ? ` · ${t('lastChecked', { when: relTime(new Date(poll.lastUpdated).toISOString(), lang) })}` : ''}
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={() => setDeployOpen(true)}>
              <Plus size={14} aria-hidden /> {t('newDeployment')}
            </button>
          </div>
        }
      />
      {deployOpen && <NewDeploymentModal source={source} applicationId={a.id} onClose={() => setDeployOpen(false)} />}
      {(mockCaption || (source instanceof MockDataSource && source.actions().length > 0)) && (
        <div className="mock-row">
          {mockCaption && (
            <span className="mock-caption">
              <span className="demo-badge demo-badge-small">DEMO DATA</span> {mockCaption}
            </span>
          )}
          {source instanceof MockDataSource && source.actions().length > 0 && (
            <span className="demo-controls" aria-label={t('demoControls')}>
              {source.actions().map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`btn btn-small ${action.id === 'fail-onprem' ? 'btn-danger' : ''}`}
                  disabled={!action.enabled()}
                  onClick={() => {
                    source.runAction(action.id);
                    poll.refresh();
                  }}
                >
                  {t(action.labelKey)}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      {latestEvent && <RouteBanner seen={latestEvent} deployments={snap.deployments} />}

      <TrafficCard snap={snap} degraded={degraded} lang={lang} swapAt={latestEvent?.at ?? null} />

      <div className="grid-2">
        <TargetsCard snap={snap} />
        <AgentsCard rows={snap.agents} deployments={snap.deployments} activeDeploymentId={route?.target.deploymentId ?? null} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('deployHistory')}</h2>
          <span className="small muted">{h.enabled ? t('healthConfig', { interval: h.intervalSeconds, threshold: h.failureThreshold }) : t('healthOff')}</span>
        </div>
        <DeploymentTimeline deployments={snap.deployments} activeDeploymentId={route?.target.deploymentId ?? null} />
      </section>

      {events.length > 1 && (
        <section className="card">
          <h2 className="card-title">{t('changesSeen')}</h2>
          <ul className="plain small">
            {events.map((e, i) => (
              <li key={e.at}>{t('bannerLine', { from: targetLabel(e.change.from.kind), to: targetLabel(e.change.to.kind), time: fmtTime(new Date(e.at).toISOString()), n: i + 1 })}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function versionOf(deployments: Deployment[], deploymentId: string): string {
  const found = deployments.find((d) => d.id === deploymentId);
  return found ? `v${found.version}` : deploymentId.slice(0, 8);
}

/** 경로 전환 알림. 상태만 짧게: 어디서 어디로, 버전과 revision. 시각·횟수는 아래 "확인한 전환" 목록에만. */
function RouteBanner({ seen, deployments }: { seen: SeenChange; deployments: Deployment[] }) {
  const { t } = useLang();
  const { change } = seen;
  const leg = (m: RouteMark) => `${targetLabel(m.kind)} (${versionOf(deployments, m.deploymentId)}, rev ${m.revision})`;
  return (
    <div className={`card banner banner-${change.failover ? 'warning' : 'info'}`} role="status">
      {change.failover ? <Shuffle size={18} className="banner-mark" aria-hidden /> : <ArrowRight size={18} className="banner-mark" aria-hidden />}
      <div className="banner-text">
        <div className="banner-title">{change.failover ? t('failoverHappened') : t('routeChanged')}</div>
        <div className="banner-route">
          {leg(change.from)} → {leg(change.to)}
        </div>
        {change.failover && <div className="banner-body">{t('noFailback', { from: targetLabel(change.from.kind) })}</div>}
      </div>
    </div>
  );
}

/** 현재 route 와 standby 를 고른다. standby 는 같은 deployment 의 다른 enabled target (자동 failover 는 onprem → cloud_run 만). */
function pickTargets(snap: Snapshot) {
  const route = snap.route;
  const current = route ? snap.targets.find((x) => x.target.id === route.target.id) ?? { target: route.target, health: route.health } : null;
  const standby = route ? snap.targets.find((x) => x.target.id !== route.target.id && x.target.deploymentId === route.target.deploymentId && x.target.enabled) ?? null : null;
  return { current, standby };
}

/** swapAt: lib/failover 가 실제 route 변화를 관찰한 시각. 그때만 현재 트래픽 블록이 전환 애니메이션으로 다시 그려진다 */
function TrafficCard({ snap, degraded, lang, swapAt }: { snap: Snapshot; degraded: boolean; lang: 'ko' | 'ja'; swapAt: number | null }) {
  const { t } = useLang();
  const route = snap.route;
  const { current, standby } = pickTargets(snap);
  const version = route ? snap.deployments.find((d) => d.id === route.target.deploymentId)?.version : undefined;
  const cur = effectiveStatus(current?.health ?? null);
  const curTone = route ? healthTone(cur.status) : 'muted';
  const agentName = current?.target.agentId ? snap.app.agents.find((x) => x.id === current.target.agentId)?.name : undefined;
  const agentRow = current?.target.agentId ? snap.agents.find((x) => x.agent.id === current.target.agentId) : undefined;
  const sb = effectiveStatus(standby?.health ?? null);
  const policy = snap.routePolicy;
  const failoverOn = policy ? policy.failoverAllowed : null;
  const standbyCanTakeOver = Boolean(standby && standby.target.kind === 'cloud_run' && failoverOn);
  return (
    <section className={`card traffic ${degraded ? 'traffic-degraded' : ''}`}>
      <div className="card-head">
        <h2 className="card-title">{t('currentTraffic')}</h2>
        <span className="card-aside">
          <span className="small muted">
            {t('switchCount')} {route ? route.revision : '-'}
          </span>
          <span className="hint">{t('routeRevisionHint')}</span>
        </span>
      </div>
      {!route ? (
        <Empty>{t('noRouteNote')}</Empty>
      ) : (
        <div className="traffic-grid">
          <div key={swapAt ?? 'initial'} className={`traffic-main${swapAt !== null ? ' traffic-main-swap' : ''}`}>
            <div className="traffic-text">
              <div className="traffic-kind">
                {route.target.kind === 'onprem' ? <Server size={20} className="kind-icon" aria-hidden /> : <Cloud size={20} className="kind-icon" aria-hidden />}
                {targetLabel(route.target.kind)}
              </div>
              <div className="row">
                {version !== undefined && <span className="muted">v{version}</span>}
                <Pill tone={curTone}>{cur.status ? t(HEALTH_KEY[cur.status] ?? 'unknown') : t('noHealth')}</Pill>
                {current?.health?.failureKind && current.health.consecutiveFailures > 0 && (
                  <Pill tone={cur.status === 'healthy' ? 'warning' : 'danger'}>{current.health.failureKind === 'network' ? t('networkError') : t('appError')}</Pill>
                )}
                {cur.expired && <Pill tone="muted">{t('observationExpired')}</Pill>}
              </div>
              <div className="small muted traffic-detail">
                {route.target.kind === 'onprem' ? (
                  <>
                    {t('agent')} {agentName ?? route.target.agentId ?? '-'}
                    {agentRow && (
                      <>
                        {' '}
                        <Pill tone={agentRow.status?.status === 'online' ? 'success' : agentRow.status?.status === 'offline' ? 'danger' : 'muted'}>
                          {agentRow.status?.status === 'online' ? t('agentOnline') : agentRow.status?.status === 'offline' ? t('agentOffline') : (agentRow.status?.status ?? agentRow.agent.status)}
                        </Pill>
                      </>
                    )}
                    {route.target.localPort ? ` · port ${route.target.localPort}` : ''}
                  </>
                ) : (
                  <span className="mono">{route.target.url?.replace('https://', '') ?? '-'}</span>
                )}
                {current?.health && (
                  <>
                    {' · '}
                    {current.health.consecutiveFailures > 0 ? t('consecutiveFail', { n: current.health.consecutiveFailures }) : t('consecutiveOk', { n: current.health.consecutiveSuccesses })}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="traffic-side">
            <div className="field-label">{t('standbyLabel')}</div>
            {standby ? (
              <div className="row">
                {standby.target.kind === 'onprem' ? <Server size={16} className="kind-icon" aria-hidden /> : <Cloud size={16} className="kind-icon" aria-hidden />}
                <span className="traffic-standby">{targetLabel(standby.target.kind)}</span>
                <Pill tone={healthTone(sb.status)}>{sb.status ? t(HEALTH_KEY[sb.status] ?? 'unknown') : t('noHealth')}</Pill>
              </div>
            ) : (
              <div className="muted">{t('none')}</div>
            )}
            <div className="field-label">{t('failoverLabel')}</div>
            <div className="row">
              {snap.routePolicyError ? (
                <span className="small muted">{describeError(snap.routePolicyError, lang).title}</span>
              ) : failoverOn === null ? (
                <span className="muted">{t('none')}</span>
              ) : (
                <Pill tone={failoverOn ? 'success' : 'muted'}>{failoverOn ? t('failoverOn') : t('failoverOff')}</Pill>
              )}
              {standby && failoverOn && !standbyCanTakeOver && <span className="small muted">{t('noFailbackShort')}</span>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TargetsCard({ snap }: { snap: Snapshot }) {
  const { t, lang } = useLang();
  const route = snap.route;
  const kinds: TargetKind[] = ['onprem', 'cloud_run'];
  const rows = kinds.map((kind) => {
    const ofKind = snap.targets.filter((x) => x.target.kind === kind);
    const active = route ? ofKind.find((x) => x.target.id === route.target.id) : undefined;
    const sameDeployment = route ? ofKind.find((x) => x.target.deploymentId === route.target.deploymentId && x.target.enabled) : undefined;
    const primary = active ?? sameDeployment ?? ofKind.find((x) => x.target.enabled) ?? ofKind[0];
    const version = primary ? snap.deployments.find((d) => d.id === primary.target.deploymentId)?.version : undefined;
    return { kind, primary, isActive: Boolean(active), version, others: primary ? ofKind.filter((x) => x.target.id !== primary.target.id) : [] };
  });
  return (
    <section className="card">
      <h2 className="card-title">{t('targetsStatus')}</h2>
      <ul className="target-rows">
        {rows.map(({ kind, primary, isActive, version }) => {
          const st = effectiveStatus(primary?.health ?? null);
          const tone = primary ? healthTone(st.status) : 'muted';
          return (
            <li key={kind} className={`target-row ${isActive ? `target-row-active tone-${tone}` : ''}`}>
              {kind === 'onprem' ? <Server size={16} className="kind-icon" aria-hidden /> : <Cloud size={16} className="kind-icon" aria-hidden />}
              <div className="target-row-main">
                <div className="row">
                  <strong>{targetLabel(kind)}</strong>
                  {version !== undefined && <span className="muted small">v{version}</span>}
                  {isActive && <span className="tag">{t('currentTag')}</span>}
                </div>
                <div className="small muted">
                  {!primary
                    ? t('notRegisteredNote', { target: targetLabel(kind) })
                    : primary.health
                      ? `${t('lastObserved')} ${relTime(primary.health.observedAt, lang)}${primary.health.consecutiveFailures > 0 ? ` · ${t('consecutiveFail', { n: primary.health.consecutiveFailures })}` : ''}`
                      : t('noHealth')}
                </div>
              </div>
              {primary ? <Pill tone={tone}>{st.status ? t(HEALTH_KEY[st.status] ?? 'unknown') : t('noHealth')}</Pill> : <Pill tone="muted">{t('notRegistered')}</Pill>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AgentsCard({ rows, deployments, activeDeploymentId }: { rows: AgentRow[]; deployments: Deployment[]; activeDeploymentId: string | null }) {
  const { t, lang } = useLang();
  return (
    <section className="card">
      <h2 className="card-title">{t('agentCard')}</h2>
      {rows.length === 0 && <Empty>{t('noAgents')}</Empty>}
      <ul className="agent-list">
        {rows.map(({ agent, status, error }) => {
          const s = status?.status ?? agent.status;
          const agentTone: Tone = s === 'online' ? 'success' : s === 'offline' || s === 'revoked' ? 'danger' : 'muted';
          const serving = status?.serving ?? null;
          return (
            <li key={agent.id} className="agent-row">
              <div className="row-between">
                <span className="row row-tight">
                  <Server size={16} className="kind-icon" aria-hidden />
                  <strong>{agent.name}</strong>
                  {!status && <span className="small muted">DB</span>}
                </span>
                <Pill tone={agentTone} icon={s === 'online' ? Check : s === 'offline' ? X : Minus}>
                  {s === 'online' ? t('agentOnline') : s === 'offline' ? t('agentOffline') : s}
                </Pill>
              </div>
              {error ? <ErrorNotice error={error} /> : null}
              <dl className="fields-v">
                <div className="field-v">
                  <dt>{t('lastSeen')}</dt>
                  <dd>{status?.last_seen_at ? `${relTime(status.last_seen_at, lang)} (${fmtTime(status.last_seen_at)})` : agent.lastSeenAt ? relTime(agent.lastSeenAt, lang) : t('none')}</dd>
                </div>
                <div className="field-v">
                  <dt>{t('serving')}</dt>
                  <dd>
                    {serving ? (
                      <span className="row row-tight">
                        <a href={hrefFor(deploymentPath(serving.run_id))}>{versionOf(deployments, serving.run_id)}</a>
                        <Hash value={serving.digest} length={12} />
                        {activeDeploymentId === serving.run_id && <span className="tag">{t('currentRouteVersion')}</span>}
                      </span>
                    ) : (
                      <span className="muted">{t('none')}</span>
                    )}
                  </dd>
                </div>
                {serving && (
                  <div className="field-v">
                    <dt>{t('containerLabel')}</dt>
                    <dd>
                      <Hash value={serving.container} length={32} />
                    </dd>
                  </div>
                )}
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DeploymentTimeline({ deployments, activeDeploymentId }: { deployments: Deployment[]; activeDeploymentId: string | null }) {
  const { t } = useLang();
  if (deployments.length === 0) return <Empty>{t('none')}</Empty>;
  return (
    <ol className="history">
      {deployments.map((d) => (
        <li key={d.id}>
          <a className="history-item" href={hrefFor(deploymentPath(d.id))}>
            <span className="history-version">v{d.version}</span>
            <Pill tone={STATUS_TONE[d.status]} icon={STATUS_ICON[d.status]} spin={d.status === 'running'}>
              {t(STATUS_KEY[d.status])}
            </Pill>
            {d.decision && <Pill tone={d.decision === 'allow' ? 'success' : d.decision === 'block' ? 'danger' : 'warning'}>{d.decision === 'allow' ? 'ALLOW' : d.decision === 'block' ? 'BLOCK' : 'NEEDS_APPROVAL'}</Pill>}
            {!d.deploymentPerformed && d.status === 'succeeded' && <span className="small muted">{t('notDeployed')}</span>}
            <span className="history-meta">
              {d.id === activeDeploymentId && <span className="tag">{t('servingNow')}</span>}
              <span className="mono">{d.sourceRevision.slice(0, 7)}</span>
              <span className="small muted">{fmtTime(d.createdAt)}</span>
            </span>
            <ChevronRight size={16} className="row-icon" aria-hidden />
          </a>
        </li>
      ))}
    </ol>
  );
}
