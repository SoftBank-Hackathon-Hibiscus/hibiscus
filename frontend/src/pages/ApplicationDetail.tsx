import { Activity, ArrowRight, Cloud, GitBranch, Hash as HashIcon, Server, Shuffle, Waypoints, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type DataSource } from '../api/client';
import { MockDataSource } from '../api/mock';
import type { AgentStatusResponse, ApplicationAgentSummary, ApplicationView, Deployment, DeploymentStatus, PolicyResult, RouteSnapshot, RoutingTargetView, TargetKind } from '../api/types';
import { ErrorNotice, describeError } from '../components/ErrorNotice';
import { Empty, Hash, IconTile, Kv, MoreToggle, PageTitle, Pill, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { fmtTime, relTime, targetLabel } from '../lib/format';
import { useLang, type DictKey } from '../lib/i18n';
import { deploymentPath, hrefFor } from '../lib/router';

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

interface RouteChange {
  at: number;
  fromKind: TargetKind | null;
  toKind: TargetKind;
  fromRevision: number | null;
  toRevision: number;
}

const STATUS_TONE: Record<DeploymentStatus, Tone> = { queued: 'info', running: 'info', awaiting_approval: 'warning', blocked: 'danger', failed: 'danger', succeeded: 'success' };
const STATUS_KEY: Record<DeploymentStatus, DictKey> = { queued: 'statusQueued', running: 'statusRunning', awaiting_approval: 'statusAwaiting', blocked: 'statusBlocked', failed: 'statusFailed', succeeded: 'statusSucceeded' };
const HEALTH_KEY: Record<string, DictKey> = { healthy: 'healthy', unhealthy: 'unhealthy', unknown: 'unknown' };

function healthTone(status: string | undefined): Tone {
  if (status === 'healthy') return 'success';
  if (status === 'unhealthy') return 'danger';
  return 'muted';
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

  const [events, setEvents] = useState<RouteChange[]>([]);
  const previousRoute = useRef<RouteSnapshot | null | undefined>(undefined);
  useEffect(() => {
    if (!poll.data) return;
    const current = poll.data.route;
    const previous = previousRoute.current;
    if (previous !== undefined && current) {
      const changed = !previous || previous.revision !== current.revision || previous.target.id !== current.target.id;
      if (changed) {
        setEvents((list) => [...list, { at: poll.data!.fetchedAt, fromKind: previous?.target.kind ?? null, toKind: current.target.kind, fromRevision: previous?.revision ?? null, toRevision: current.revision }]);
      }
    }
    previousRoute.current = current;
  }, [poll.data]);

  const snap = poll.data;
  if (poll.loading && !snap) return <Empty>{t('loading')}</Empty>;
  if (!snap) return <ErrorNotice error={poll.error ?? new Error('no data')} />;

  const a = snap.app.application;
  const h = snap.app.healthCheck;
  const route = snap.route;
  const latestEvent = events[events.length - 1];
  const failedOver = Boolean(latestEvent && latestEvent.fromKind === 'onprem' && latestEvent.toKind === 'cloud_run');
  const onpremUnhealthy = snap.targets.some((x) => x.target.kind === 'onprem' && x.health?.status === 'unhealthy');
  const routeHealth = route ? (route.health && Date.parse(route.health.expiresAt) >= Date.now() ? route.health.status : 'unknown') : undefined;
  const mockCaption = source instanceof MockDataSource ? source.frameCaption() : null;

  const headline = !route ? t('noRouteNote') : route.target.kind === 'cloud_run' && (failedOver || onpremUnhealthy) ? t('trafficFailedOver') : t('trafficOn', { target: targetLabel(route.target.kind) });
  const headlineTone: Tone = !route ? 'muted' : route.target.kind === 'cloud_run' && (failedOver || onpremUnhealthy) ? 'warning' : 'success';

  return (
    <div className="page">
      {latestEvent && <RouteBanner event={latestEvent} count={events.length} />}
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <PageTitle
        title={a.name}
        sub={
          <span className={`conclusion conclusion-${headlineTone}`}>
            <span className="conclusion-dot" aria-hidden />
            {headline}
          </span>
        }
        right={
          <div className="title-badges">
            {a.publicHost && <span className="mono muted small">{a.publicHost}</span>}
            <span className="live">
              {t('refreshing5s')}
              {poll.lastUpdated ? `, ${relTime(new Date(poll.lastUpdated).toISOString())}` : ''}
            </span>
          </div>
        }
      />
      {mockCaption && (
        <div className="mock-caption">
          <span className="demo-badge demo-badge-small">DEMO DATA</span> {mockCaption}
        </div>
      )}

      <section className="stats">
        <StatCard icon={Waypoints} tone={headlineTone === 'muted' ? 'accent' : headlineTone} label={t('trafficNow')} value={route ? targetLabel(route.target.kind) : t('noRoute')} />
        <StatCard
          icon={Activity}
          tone={route ? healthTone(routeHealth) : 'accent'}
          label={t('status')}
          value={route ? t(HEALTH_KEY[routeHealth ?? 'unknown'] ?? 'unknown') : t('none')}
          pill={route ? <Pill tone={healthTone(routeHealth)}>{routeHealth}</Pill> : undefined}
        />
        <StatCard
          icon={Shuffle}
          tone="accent"
          label={t('failoverPolicy')}
          value={!route ? t('none') : snap.routePolicyError ? describeError(snap.routePolicyError, lang).title : snap.routePolicy ? (snap.routePolicy.failoverAllowed ? t('allow') : t('denied')) : t('none')}
        />
        <StatCard icon={HashIcon} tone="accent" label={t('routeRevision')} value={route ? String(route.revision) : t('none')} />
      </section>

      <section className="targets">
        <TargetCard kind="onprem" snap={snap} agents={snap.agents} />
        <TargetCard kind="cloud_run" snap={snap} agents={[]} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('deployHistory')}</h2>
          <span className="small muted">{h.enabled ? t('healthConfig', { method: h.method, path: h.path, interval: h.intervalSeconds, threshold: h.failureThreshold }) : t('healthOff')}</span>
        </div>
        <DeploymentTimeline deployments={snap.deployments} activeDeploymentId={route?.target.deploymentId ?? null} />
      </section>

      {events.length > 1 && (
        <section className="card">
          <h2 className="card-title">{t('changesSeen')}</h2>
          <ul className="plain">
            {events.map((e) => (
              <li key={e.at}>
                {fmtTime(new Date(e.at).toISOString())}: {e.fromKind ? targetLabel(e.fromKind) : t('none')} <ArrowRight size={14} className="inline-icon" aria-hidden /> {targetLabel(e.toKind)} (rev {e.fromRevision ?? '-'} <ArrowRight size={12} className="inline-icon" aria-hidden /> {e.toRevision})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatCard({ icon, tone, label, value, pill }: { icon: LucideIcon; tone: Tone | 'accent'; label: string; value: string; pill?: React.ReactNode }) {
  return (
    <div className="card stat">
      <IconTile icon={icon} tone={tone} />
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {pill && <div className="stat-pill">{pill}</div>}
    </div>
  );
}

function RouteBanner({ event, count }: { event: RouteChange; count: number }) {
  const { t } = useLang();
  const isFailover = event.fromKind === 'onprem' && event.toKind === 'cloud_run';
  return (
    <div className={`banner banner-${isFailover ? 'warning' : 'info'}`} role="alert">
      <IconTile icon={Shuffle} tone={isFailover ? 'warning' : 'info'} size={36} />
      <div>
        <div className="banner-title">
          {isFailover ? t('failoverHappened') : t('routeChanged')} (rev {event.fromRevision ?? '-'} <ArrowRight size={16} className="inline-icon" aria-hidden /> {event.toRevision})
        </div>
        <div className="banner-body">
          {event.fromKind ? targetLabel(event.fromKind) : t('none')} <ArrowRight size={14} className="inline-icon" aria-hidden /> <strong>{targetLabel(event.toKind)}</strong>, {fmtTime(new Date(event.at).toISOString())}
          {isFailover && `. ${t('noFailback')}`}
          {count > 1 && ` (${count})`}
        </div>
      </div>
    </div>
  );
}

function TargetCard({ kind, snap, agents }: { kind: TargetKind; snap: Snapshot; agents: AgentRow[] }) {
  const { t } = useLang();
  const route = snap.route;
  const ofKind = snap.targets.filter((x) => x.target.kind === kind);
  const primary = useMemo(() => {
    if (ofKind.length === 0) return undefined;
    const active = route ? ofKind.find((x) => x.target.id === route.target.id) : undefined;
    if (active) return active;
    const sameDeployment = route ? ofKind.find((x) => x.target.deploymentId === route.target.deploymentId && x.target.enabled) : undefined;
    return sameDeployment ?? ofKind.find((x) => x.target.enabled) ?? ofKind[0];
  }, [ofKind, route]);
  const isActive = Boolean(route && primary && route.target.id === primary.target.id);
  const sameDeploymentAsRoute = Boolean(route && primary && !isActive && primary.target.enabled && primary.target.deploymentId === route.target.deploymentId);
  const isStandby = sameDeploymentAsRoute && kind === 'cloud_run';
  const isFormerPrimary = sameDeploymentAsRoute && kind === 'onprem';
  const health = isActive && route?.health ? route.health : primary?.health ?? null;
  const expired = health ? Date.parse(health.expiresAt) < Date.now() : false;
  const displayStatus = health ? (expired ? 'unknown' : health.status) : undefined;
  const tone = primary ? healthTone(displayStatus) : 'muted';
  const version = primary ? snap.deployments.find((x) => x.id === primary.target.deploymentId)?.version : undefined;
  const Icon = kind === 'onprem' ? Server : Cloud;

  return (
    <div className={`card target-card ${isActive ? `target-active target-active-${tone}` : ''} ${primary ? '' : 'target-missing'}`}>
      <div className={`traffic-strip ${isActive ? 'traffic-on' : ''}`} aria-hidden>
        {isActive ? (
          <>
            <span className="mono">{snap.app.application.publicHost ?? t('gateway')}</span>
            <ArrowRight size={16} />
            <span>{t('hereNow')}</span>
          </>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
      <div className="target-head">
        <IconTile icon={Icon} tone={primary ? (isActive ? (tone === 'muted' ? 'accent' : tone) : 'accent') : 'muted'} size={44} />
        <div className="target-title">
          <h2>{targetLabel(kind)}</h2>
          <span className="small muted">
            {primary ? (
              <>
                {version !== undefined ? `v${version}` : ''} {kind === 'cloud_run' && primary.target.url ? primary.target.url.replace('https://', '') : ''}
                {kind === 'onprem' && primary.target.localPort ? `:${primary.target.localPort}` : ''}
              </>
            ) : (
              t('notRegisteredNote', { target: targetLabel(kind) })
            )}
          </span>
        </div>
        {isActive && <Pill tone={tone === 'muted' ? 'info' : tone}>{t('hereNow')}</Pill>}
        {isStandby && <Pill tone="info">{snap.routePolicy ? (snap.routePolicy.failoverAllowed ? t('standbyFailover') : t('standbyNoFailover')) : t('waiting')}</Pill>}
        {isFormerPrimary && <Pill tone="muted">{t('manualAfterRecovery')}</Pill>}
        {!primary && <Pill tone="muted">{t('notRegistered')}</Pill>}
        {primary && !isActive && !isStandby && !isFormerPrimary && <Pill tone="muted">{primary.target.enabled ? t('waiting') : t('inactive')}</Pill>}
      </div>
      {primary && (
        <>
          <div className="target-status">
            <span className={`status-big tone-${tone}`}>{displayStatus ? t(HEALTH_KEY[displayStatus] ?? 'unknown') : t('noHealth')}</span>
            {health?.failureKind && displayStatus !== 'healthy' && <Pill tone="danger">{health.failureKind === 'network' ? t('networkError') : t('appError')}</Pill>}
            {health && <span className="muted small">{displayStatus === 'healthy' ? t('consecutiveOk', { n: health.consecutiveSuccesses }) : t('consecutiveFail', { n: health.consecutiveFailures })}</span>}
            {expired && <Pill tone="muted">{t('observationExpired')}</Pill>}
          </div>
          {health?.reason && displayStatus !== 'healthy' && <div className="mono small tone-danger">{health.reason}</div>}
          {kind === 'onprem' && agents.length > 0 && (
            <ul className="agent-list">
              {agents.map(({ agent, status, error }) => {
                const s = status?.status ?? agent.status;
                const agentTone: Tone = s === 'online' ? 'success' : s === 'offline' || s === 'revoked' ? 'danger' : 'muted';
                return (
                  <li key={agent.id} className="agent-row">
                    <span className="muted small">{t('agent')}</span>
                    <strong>{agent.name}</strong>
                    <Pill tone={agentTone}>{s}</Pill>
                    <span className="small muted">{status?.last_seen_at ? relTime(status.last_seen_at) : agent.lastSeenAt ? relTime(agent.lastSeenAt) : ''}</span>
                    {error ? <span className="small tone-danger">{describeError(error).title}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {kind === 'onprem' && agents.length === 0 && <div className="small muted">{t('noAgents')}</div>}
          <MoreToggle>
            <Kv
              columns={2}
              items={[
                ['deployment', <Hash value={primary.target.deploymentId} length={18} />],
                ['target', <Hash value={primary.target.id} length={18} />],
                kind === 'onprem' ? [t('ports'), <span className="mono">local {primary.target.localPort ?? '-'}, gateway {primary.target.gatewayPort ?? '-'}</span>] : null,
                kind === 'cloud_run' ? ['URL', primary.target.url ? <Hash value={primary.target.url} length={40} /> : t('none')] : null,
                ['enabled', primary.target.enabled ? t('yes') : t('no')],
                [t('lastObserved'), health ? `${relTime(health.observedAt)} (${fmtTime(health.observedAt)})` : t('none')],
                ...agents.flatMap(({ agent, status }) =>
                  status?.serving
                    ? ([[`${t('serving')} (${agent.name})`, <Hash value={status.serving.container} length={28} />]] as Array<[string, React.ReactNode]>)
                    : [],
                ),
              ]}
            />
          </MoreToggle>
        </>
      )}
    </div>
  );
}

function DeploymentTimeline({ deployments, activeDeploymentId }: { deployments: Deployment[]; activeDeploymentId: string | null }) {
  const { t } = useLang();
  if (deployments.length === 0) return <Empty>{t('none')}</Empty>;
  return (
    <ol className="history">
      {deployments.map((d) => (
        <li key={d.id} className={`history-item ${d.id === activeDeploymentId ? 'history-active' : ''}`}>
          <span className={`history-dot dot-${STATUS_TONE[d.status]}`} aria-hidden />
          <a className="history-version" href={hrefFor(deploymentPath(d.id))}>
            v{d.version}
          </a>
          <span className="history-meta">
            <Pill tone={STATUS_TONE[d.status]}>{t(STATUS_KEY[d.status])}</Pill>
            {d.decision && <span className="mono small">{d.decision}</span>}
            {d.id === activeDeploymentId && <Pill tone="success">{t('servingNow')}</Pill>}
            {!d.deploymentPerformed && d.status === 'succeeded' && <span className="small muted">{t('notDeployed')}</span>}
          </span>
          <span className="history-time small muted">
            <GitBranch size={13} className="inline-icon" aria-hidden /> <Hash value={d.sourceRevision} length={7} /> {fmtTime(d.createdAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}
