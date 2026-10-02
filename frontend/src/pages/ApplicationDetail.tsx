import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type DataSource } from '../api/client';
import type { AgentStatusResponse, ApplicationAgentSummary, ApplicationView, Deployment, DeploymentStatus, PolicyResult, RouteSnapshot, RoutingTargetView, TargetKind } from '../api/types';
import { ErrorNotice, describeError } from '../components/ErrorNotice';
import { Badge, Empty, Hash, Kv, Notice, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { fmtTime, relTime, targetLabel } from '../lib/format';
import { deploymentPath, hrefFor } from '../lib/router';
import { MockDataSource } from '../api/mock';

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
  /** 현재 route target 의 deployment 정책 결과 (failover_allowed 출처) */
  routePolicy: PolicyResult | null;
  routePolicyError: unknown;
  fetchedAt: number;
}

interface FailoverEvent {
  at: number;
  fromKind: TargetKind | null;
  toKind: TargetKind;
  fromRevision: number | null;
  toRevision: number;
}

const STATUS_TONE: Record<DeploymentStatus, Tone> = {
  queued: 'info',
  running: 'info',
  awaiting_approval: 'warning',
  blocked: 'danger',
  failed: 'danger',
  succeeded: 'success',
};

export function ApplicationDetail({ id, source }: { id: string; source: DataSource }) {
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
      // application 에 agent 가 없으면 상태 조회를 건너뛴다
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
        if (policyCache.current.has(depId)) {
          routePolicy = policyCache.current.get(depId) ?? null;
        } else {
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

  const [events, setEvents] = useState<FailoverEvent[]>([]);
  const previousRoute = useRef<RouteSnapshot | null | undefined>(undefined);
  useEffect(() => {
    if (!poll.data) return;
    const current = poll.data.route;
    const previous = previousRoute.current;
    if (previous !== undefined && current) {
      const changed = !previous || previous.revision !== current.revision || previous.target.id !== current.target.id;
      if (changed) {
        setEvents((list) => [
          ...list,
          {
            at: poll.data!.fetchedAt,
            fromKind: previous?.target.kind ?? null,
            toKind: current.target.kind,
            fromRevision: previous?.revision ?? null,
            toRevision: current.revision,
          },
        ]);
      }
    }
    previousRoute.current = current;
  }, [poll.data]);

  const snap = poll.data;
  if (poll.loading && !snap) return <Empty>애플리케이션 정보를 불러오는 중…</Empty>;
  if (!snap) return <ErrorNotice error={poll.error ?? new Error('데이터 없음')} />;

  const mockCaption = source instanceof MockDataSource ? source.frameCaption() : null;
  const latestEvent = events[events.length - 1];

  return (
    <div className="page">
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <Header snap={snap} lastUpdated={poll.lastUpdated} />
      {mockCaption && <div className="mock-caption">mock 진행: {mockCaption}</div>}
      {latestEvent && <FailoverBanner event={latestEvent} count={events.length} />}
      <RouteSummary snap={snap} />
      <TargetCards snap={snap} />
      <AgentsSection rows={snap.agents} />
      <DeploymentsSection deployments={snap.deployments} activeDeploymentId={snap.route?.target.deploymentId ?? null} />
      {events.length > 1 && (
        <section className="card">
          <h2 className="h2">route 변경 (이 화면에서 관측)</h2>
          <ul className="plain">
            {events.map((e) => (
              <li key={e.at}>
                {fmtTime(new Date(e.at).toISOString())} · {e.fromKind ? targetLabel(e.fromKind) : '없음'} → {targetLabel(e.toKind)} (rev {e.fromRevision ?? '—'} → {e.toRevision})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Header({ snap, lastUpdated }: { snap: Snapshot; lastUpdated: number | null }) {
  const a = snap.app.application;
  const h = snap.app.healthCheck;
  return (
    <header className="page-header">
      <div className="crumbs">
        <span>애플리케이션</span>
      </div>
      <div className="title-row">
        <h1>
          {a.name} <span className="muted mono small">{a.slug}</span>
        </h1>
        <div className="title-badges">
          {a.publicHost && <span className="chip mono">{a.publicHost}</span>}
          <span className="chip">
            health {h.enabled ? `${h.method} ${h.path} · ${h.intervalSeconds}초 · 실패 ${h.failureThreshold}회` : '꺼짐'}
          </span>
          <span className="live">5초마다 갱신{lastUpdated ? ` · ${relTime(new Date(lastUpdated).toISOString())}` : ''}</span>
        </div>
      </div>
    </header>
  );
}

function FailoverBanner({ event, count }: { event: FailoverEvent; count: number }) {
  const isFailover = event.fromKind === 'onprem' && event.toKind === 'cloud_run';
  const title = isFailover
    ? `failover 발생 (rev ${event.fromRevision ?? '—'} → ${event.toRevision})`
    : `route 변경 (rev ${event.fromRevision ?? '—'} → ${event.toRevision})`;
  return (
    <Notice tone={isFailover ? 'warning' : 'info'} title={title}>
      {event.fromKind ? targetLabel(event.fromKind) : '없음'} → <strong>{targetLabel(event.toKind)}</strong> · {fmtTime(new Date(event.at).toISOString())}
      {isFailover && ' · 자동 failback 은 없음. 온프레 복구 뒤 수동 route 변경 필요'}
      {count > 1 && ` · 총 ${count}회 변경`}
    </Notice>
  );
}

function RouteSummary({ snap }: { snap: Snapshot }) {
  const route = snap.route;
  const policy = snap.routePolicy;
  const version = route ? snap.deployments.find((d) => d.id === route.target.deploymentId)?.version : undefined;
  return (
    <section className="card route-summary">
      <div className="route-main">
        <span className="route-label">현재 트래픽</span>
        {route ? (
          <span className={`route-value route-${route.target.kind}`}>{targetLabel(route.target.kind)}</span>
        ) : (
          <span className="route-value route-none">경로 없음</span>
        )}
      </div>
      <Kv
        columns={3}
        items={[
          ['route revision', route ? <strong>{route.revision}</strong> : <span className="muted">—</span>],
          ['서빙 배포', route ? <span>{version !== undefined ? `v${version} ` : ''}<Hash value={route.target.deploymentId} length={16} /></span> : <span className="muted">—</span>],
          [
            'failover 허용 (정책)',
            !route ? (
              <span className="muted">—</span>
            ) : snap.routePolicyError ? (
              <span className="small muted">조회 실패: {describeError(snap.routePolicyError).title}</span>
            ) : policy ? (
              policy.failoverAllowed ? <Badge tone="success">허용</Badge> : <Badge tone="muted">불가</Badge>
            ) : (
              <span className="muted">정책 결과 없음</span>
            ),
          ],
        ]}
      />
      {!route && <div className="small muted">첫 route 전환(PATCH /applications/:id/routing) 전이라 GET routing 이 404</div>}
    </section>
  );
}

function TargetCards({ snap }: { snap: Snapshot }) {
  const kinds: TargetKind[] = ['onprem', 'cloud_run'];
  return (
    <section className="targets">
      {kinds.map((kind) => (
        <TargetCard key={kind} kind={kind} snap={snap} />
      ))}
    </section>
  );
}

function healthTone(status: string | undefined): Tone {
  if (status === 'healthy') return 'success';
  if (status === 'unhealthy') return 'danger';
  return 'muted';
}
const HEALTH_LABEL: Record<string, string> = { healthy: 'healthy', unhealthy: 'unhealthy', unknown: 'unknown' };

function TargetCard({ kind, snap }: { kind: TargetKind; snap: Snapshot }) {
  const route = snap.route;
  const ofKind = snap.targets.filter((t) => t.target.kind === kind);
  const primary = useMemo(() => {
    if (ofKind.length === 0) return undefined;
    const active = route ? ofKind.find((t) => t.target.id === route.target.id) : undefined;
    if (active) return active;
    const sameDeployment = route ? ofKind.find((t) => t.target.deploymentId === route.target.deploymentId && t.target.enabled) : undefined;
    return sameDeployment ?? ofKind.find((t) => t.target.enabled) ?? ofKind[0];
  }, [ofKind, route]);
  const isActive = Boolean(route && primary && route.target.id === primary.target.id);
  // 자동 failover 는 onprem → cloud_run 방향만 있고 failback 은 없다. 그래서 standby 는 Cloud Run 에만 붙인다.
  const sameDeploymentAsRoute = Boolean(route && primary && !isActive && primary.target.enabled && primary.target.deploymentId === route.target.deploymentId);
  const isStandby = sameDeploymentAsRoute && kind === 'cloud_run';
  const isFormerPrimary = sameDeploymentAsRoute && kind === 'onprem';
  const health = isActive && route?.health ? route.health : primary?.health ?? null;
  const expired = health ? Date.parse(health.expiresAt) < Date.now() : false;
  const displayStatus = health ? (expired ? 'unknown' : health.status) : undefined;
  const tone = primary ? healthTone(displayStatus) : 'muted';
  const version = primary ? snap.deployments.find((d) => d.id === primary.target.deploymentId)?.version : undefined;
  const agentName = primary?.target.agentId ? snap.app.agents.find((a) => a.id === primary.target.agentId)?.name : undefined;
  const others = primary ? ofKind.filter((t) => t.target.id !== primary.target.id) : [];

  return (
    <div className={`target-card target-${kind} ${isActive ? 'target-active' : ''} ${primary ? '' : 'target-missing'} tone-${tone}`}>
      <div className="target-head">
        <h2>{targetLabel(kind)}</h2>
        {isActive && <span className="pill pill-active">ACTIVE · 트래픽 받는 중</span>}
        {isStandby && <span className="pill pill-standby">STANDBY{snap.routePolicy ? (snap.routePolicy.failoverAllowed ? ' · failover 대상' : ' · failover 불가') : ''}</span>}
        {!primary && <span className="pill pill-muted">등록 안 됨</span>}
        {isFormerPrimary && <span className="pill pill-muted">대기 · 복구 뒤 수동 전환</span>}
        {primary && !isActive && !isStandby && !isFormerPrimary && <span className="pill pill-muted">{primary.target.enabled ? '대기' : '비활성'}</span>}
      </div>
      {!primary ? (
        <Empty>{targetLabel(kind)} target 이 등록되지 않음</Empty>
      ) : (
        <>
          <div className="health-row">
            <Badge tone={tone}>{displayStatus ? HEALTH_LABEL[displayStatus] : 'health 없음'}</Badge>
            {health?.failureKind && displayStatus !== 'healthy' && <span className="chip chip-danger mono">{health.failureKind}</span>}
            {health && (
              <span className="small muted">
                연속 {displayStatus === 'healthy' ? `성공 ${health.consecutiveSuccesses}` : `실패 ${health.consecutiveFailures}`}
              </span>
            )}
            {expired && <span className="chip chip-muted">관측 만료</span>}
          </div>
          {health?.reason && displayStatus !== 'healthy' && <div className="mono small health-reason">{health.reason}</div>}
          <Kv
            columns={2}
            items={[
              ['배포', <span>{version !== undefined ? `v${version} ` : ''}<Hash value={primary.target.deploymentId} length={14} /></span>],
              ['target', <Hash value={primary.target.id} length={14} />],
              kind === 'onprem' ? ['에이전트', <span className="mono">{agentName ?? primary.target.agentId ?? '—'}</span>] : null,
              kind === 'onprem' ? ['포트', <span className="mono">local {primary.target.localPort ?? '—'} → gateway {primary.target.gatewayPort ?? '—'}</span>] : null,
              kind === 'cloud_run' ? ['URL', primary.target.url ? <a className="mono small" href={primary.target.url} target="_blank" rel="noreferrer">{primary.target.url}</a> : '—'] : null,
              ['enabled', primary.target.enabled ? <Badge tone="success">예</Badge> : <Badge tone="muted">아니오</Badge>],
              ['마지막 관측', health ? `${relTime(health.observedAt)} (${fmtTime(health.observedAt)})` : '—'],
            ]}
          />
          {others.length > 0 && (
            <div className="small muted">
              같은 종류 target {others.length}개 더: {others.map((t) => `${t.target.id.slice(0, 10)}… (${t.health?.status ?? 'health 없음'})`).join(', ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AgentsSection({ rows }: { rows: AgentRow[] }) {
  return (
    <section className="card">
      <h2 className="h2">On-Prem 에이전트</h2>
      {rows.length === 0 && <Empty>이 애플리케이션에 할당된 에이전트가 없음. 상태 조회 생략</Empty>}
      <div className="agents">
        {rows.map(({ agent, status, error }) => {
          const s = status?.status ?? agent.status;
          const tone: Tone = s === 'online' ? 'success' : s === 'offline' ? 'danger' : s === 'revoked' ? 'danger' : 'muted';
          return (
            <div key={agent.id} className="agent">
              <div className="agent-head">
                <strong>{agent.name}</strong>
                <Badge tone={tone}>{s}</Badge>
                {!status && <span className="chip chip-muted">DB 값 (상태 조회 실패)</span>}
              </div>
              {error ? <ErrorNotice error={error} /> : null}
              <Kv
                columns={2}
                items={[
                  ['마지막 접속', status?.last_seen_at ? `${relTime(status.last_seen_at)} (${fmtTime(status.last_seen_at)})` : agent.lastSeenAt ? relTime(agent.lastSeenAt) : '—'],
                  ['heartbeat', status?.updated_at ? relTime(status.updated_at) : '—'],
                  ['서빙 중', status?.serving ? <span className="mono small">{status.serving.container}</span> : <span className="muted">없음</span>],
                  status?.serving ? ['서빙 run_id', <Hash value={status.serving.run_id} length={16} />] : null,
                  status?.serving ? ['서빙 digest', <Hash value={status.serving.digest} />] : null,
                  ['public_url', status?.public_url ? <span className="mono small">{status.public_url}</span> : '—'],
                  ['agent id', <Hash value={agent.id} length={14} />],
                ]}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DeploymentsSection({ deployments, activeDeploymentId }: { deployments: Deployment[]; activeDeploymentId: string | null }) {
  return (
    <section className="card">
      <h2 className="h2">배포 목록</h2>
      {deployments.length === 0 ? (
        <Empty>배포 없음</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>버전</th>
              <th>상태</th>
              <th>결정</th>
              <th>배포</th>
              <th>커밋</th>
              <th>digest</th>
              <th>생성</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} className={d.id === activeDeploymentId ? 'row-active' : ''}>
                <td>
                  <a href={hrefFor(deploymentPath(d.id))}>v{d.version}</a>
                  {d.id === activeDeploymentId && <span className="chip chip-success">서빙 중</span>}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                </td>
                <td className="mono">{d.decision ?? '—'}</td>
                <td>{d.deploymentPerformed ? <Badge tone="success">배포됨</Badge> : <span className="muted small">배포 안 됨</span>}</td>
                <td>
                  <Hash value={d.sourceRevision} length={7} />
                </td>
                <td>
                  <Hash value={d.imageDigest} length={10} />
                </td>
                <td className="small">{fmtTime(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
