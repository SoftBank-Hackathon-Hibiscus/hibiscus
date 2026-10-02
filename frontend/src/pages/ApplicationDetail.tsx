import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type DataSource } from '../api/client';
import type { AgentStatusResponse, ApplicationAgentSummary, ApplicationView, Deployment, DeploymentStatus, PolicyResult, RouteSnapshot, RoutingTargetView, TargetKind } from '../api/types';
import { ErrorNotice, describeError } from '../components/ErrorNotice';
import { Badge, Collapsible, Empty, Hash, Kv, type Tone } from '../components/ui';
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

interface RouteChange {
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
const TONE_ICON: Record<Tone, string> = { success: '✓', warning: '!', danger: '✕', info: '…', muted: '–' };

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

  const [events, setEvents] = useState<RouteChange[]>([]);
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
  if (poll.loading && !snap) return <Empty>애플리케이션 정보를 불러오는 중</Empty>;
  if (!snap) return <ErrorNotice error={poll.error ?? new Error('데이터 없음')} />;

  const mockCaption = source instanceof MockDataSource ? source.frameCaption() : null;
  const latestEvent = events[events.length - 1];
  const failedOver = Boolean(latestEvent && latestEvent.fromKind === 'onprem' && latestEvent.toKind === 'cloud_run');

  return (
    <div className="page">
      {latestEvent && <RouteBanner event={latestEvent} count={events.length} />}
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <Header snap={snap} lastUpdated={poll.lastUpdated} />
      {mockCaption && <div className="mock-caption">mock 진행: {mockCaption}</div>}
      <TrafficHeadline snap={snap} failedOver={failedOver} />
      <TargetCards snap={snap} />
      <AgentsSection rows={snap.agents} />
      <DeploymentsSection deployments={snap.deployments} activeDeploymentId={snap.route?.target.deploymentId ?? null} />
      {events.length > 1 && (
        <section className="card">
          <Collapsible title="이 화면에서 관측한 route 변경" summary={<span className="chip">{events.length}회</span>}>
            <ul className="plain">
              {events.map((e) => (
                <li key={e.at}>
                  {fmtTime(new Date(e.at).toISOString())}: {e.fromKind ? targetLabel(e.fromKind) : '없음'}에서 {targetLabel(e.toKind)}으로 (rev {e.fromRevision ?? '없음'}에서 {e.toRevision})
                </li>
              ))}
            </ul>
          </Collapsible>
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
          {a.name} {a.publicHost && <span className="muted mono small">{a.publicHost}</span>}
        </h1>
        <div className="title-badges">
          <span className="chip">{h.enabled ? `health ${h.method} ${h.path}, ${h.intervalSeconds}초마다, ${h.failureThreshold}회 실패면 전환` : 'health 검사 꺼짐'}</span>
          <span className="live">5초마다 갱신{lastUpdated ? `, ${relTime(new Date(lastUpdated).toISOString())}` : ''}</span>
        </div>
      </div>
    </header>
  );
}

function RouteBanner({ event, count }: { event: RouteChange; count: number }) {
  const isFailover = event.fromKind === 'onprem' && event.toKind === 'cloud_run';
  return (
    <div className={`banner banner-${isFailover ? 'warning' : 'info'}`} role="alert">
      <span className="banner-icon" aria-hidden>{isFailover ? '!' : '…'}</span>
      <div>
        <div className="banner-title">{isFailover ? `failover 발생 (rev ${event.fromRevision ?? '없음'} → ${event.toRevision})` : `route 변경 (rev ${event.fromRevision ?? '없음'} → ${event.toRevision})`}</div>
        <div className="banner-body">
          {event.fromKind ? targetLabel(event.fromKind) : '없음'}에서 <strong>{targetLabel(event.toKind)}</strong>으로, {fmtTime(new Date(event.at).toISOString())}
          {isFailover && '. 자동 failback은 없습니다. 온프레가 복구되면 수동으로 route를 바꿉니다.'}
          {count > 1 && ` 총 ${count}회 변경.`}
        </div>
      </div>
    </div>
  );
}

function TrafficHeadline({ snap, failedOver }: { snap: Snapshot; failedOver: boolean }) {
  const route = snap.route;
  const policy = snap.routePolicy;
  const version = route ? snap.deployments.find((d) => d.id === route.target.deploymentId)?.version : undefined;
  const onpremUnhealthy = snap.targets.some((t) => t.target.kind === 'onprem' && t.health?.status === 'unhealthy');
  let sentence: string;
  let tone: Tone;
  if (!route) {
    sentence = '아직 트래픽을 받는 곳이 없습니다';
    tone = 'muted';
  } else if (route.target.kind === 'cloud_run' && (failedOver || onpremUnhealthy)) {
    sentence = '온프레 장애로 Cloud Run에서 처리 중';
    tone = 'warning';
  } else {
    sentence = `지금 트래픽은 ${targetLabel(route.target.kind)}에서 처리 중`;
    tone = 'success';
  }
  return (
    <section className={`result result-${tone} traffic`}>
      <div className="result-conclusion">
        <span className="result-icon" aria-hidden>{TONE_ICON[tone]}</span>
        <h2 className="conclusion">{sentence}</h2>
      </div>
      <div className="identity-line">
        <span>route revision {route ? <strong>{route.revision}</strong> : <span className="muted">없음</span>}</span>
        <span>
          서빙 배포 {route ? <>{version !== undefined ? `v${version} ` : ''}<Hash value={route.target.deploymentId} length={14} /></> : <span className="muted">없음</span>}
        </span>
        <span>
          failover 정책{' '}
          {!route ? (
            <span className="muted">없음</span>
          ) : snap.routePolicyError ? (
            <span className="muted">조회 실패: {describeError(snap.routePolicyError).title}</span>
          ) : policy ? (
            policy.failoverAllowed ? <Badge tone="success">허용</Badge> : <Badge tone="muted">불가</Badge>
          ) : (
            <span className="muted">정책 결과 없음</span>
          )}
        </span>
      </div>
      {!route && <p className="muted">첫 route 전환(PATCH /applications/:id/routing) 전이라 GET routing 이 404 입니다.</p>}
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
const HEALTH_LABEL: Record<string, string> = { healthy: '정상', unhealthy: '응답 없음', unknown: '확인 중' };

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
      {isActive && <div className="target-ribbon">지금 여기로</div>}
      <div className="target-head">
        <h2>{targetLabel(kind)}</h2>
        {isStandby && <span className="pill pill-standby">대기 중{snap.routePolicy ? (snap.routePolicy.failoverAllowed ? ', failover 대상' : ', failover 불가') : ''}</span>}
        {!primary && <span className="pill pill-muted">등록 안 됨</span>}
        {isFormerPrimary && <span className="pill pill-muted">복구 뒤 수동 전환</span>}
        {primary && !isActive && !isStandby && !isFormerPrimary && <span className="pill pill-muted">{primary.target.enabled ? '대기' : '비활성'}</span>}
      </div>
      {!primary ? (
        <Empty>{targetLabel(kind)} target이 등록되지 않았습니다.</Empty>
      ) : (
        <>
          <div className="health-row">
            <span className={`health health-${tone}`}>
              <span aria-hidden>{TONE_ICON[tone]}</span> {displayStatus ? HEALTH_LABEL[displayStatus] : 'health 없음'}
            </span>
            {health?.failureKind && displayStatus !== 'healthy' && <span className="chip chip-danger">{health.failureKind === 'network' ? '네트워크 오류' : '앱 오류'}</span>}
            {health && <span className="muted">연속 {displayStatus === 'healthy' ? `성공 ${health.consecutiveSuccesses}` : `실패 ${health.consecutiveFailures}`}</span>}
            {expired && <span className="chip chip-muted">관측 만료</span>}
          </div>
          {health?.reason && displayStatus !== 'healthy' && <div className="mono small health-reason">{health.reason}</div>}
          <Kv
            columns={2}
            items={[
              ['배포', <span>{version !== undefined ? `v${version} ` : ''}<Hash value={primary.target.deploymentId} length={14} /></span>],
              ['target', <Hash value={primary.target.id} length={14} />],
              kind === 'onprem' ? ['에이전트', <span className="mono">{agentName ?? primary.target.agentId ?? '없음'}</span>] : null,
              kind === 'onprem' ? ['포트', <span className="mono">local {primary.target.localPort ?? '없음'}, gateway {primary.target.gatewayPort ?? '없음'}</span>] : null,
              kind === 'cloud_run' ? ['URL', primary.target.url ? <Hash value={primary.target.url} length={34} /> : '없음'] : null,
              ['enabled', primary.target.enabled ? '예' : '아니오'],
              ['마지막 관측', health ? `${relTime(health.observedAt)} (${fmtTime(health.observedAt)})` : '없음'],
            ]}
          />
          {others.length > 0 && (
            <div className="small muted">
              같은 종류 target {others.length}개 더: {others.map((t) => `${t.target.id.slice(0, 10)} (${t.health?.status ?? 'health 없음'})`).join(', ')}
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
      <h3>On-Prem 에이전트</h3>
      {rows.length === 0 && <Empty>이 애플리케이션에 할당된 에이전트가 없어 상태 조회를 건너뜁니다.</Empty>}
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
                  ['마지막 접속', status?.last_seen_at ? `${relTime(status.last_seen_at)} (${fmtTime(status.last_seen_at)})` : agent.lastSeenAt ? relTime(agent.lastSeenAt) : '없음'],
                  ['heartbeat', status?.updated_at ? relTime(status.updated_at) : '없음'],
                  ['서빙 중', status?.serving ? <Hash value={status.serving.container} length={28} /> : <span className="muted">없음</span>],
                  status?.serving ? ['서빙 digest', <Hash value={status.serving.digest} />] : null,
                  ['public_url', status?.public_url ? <Hash value={status.public_url} length={28} /> : '없음'],
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
      <h3>배포 목록</h3>
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
                <td className="mono">{d.decision ?? '없음'}</td>
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
