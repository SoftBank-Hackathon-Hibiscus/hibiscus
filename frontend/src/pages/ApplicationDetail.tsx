import { useEffect, useRef, useState } from "react";
import { api, MOCK } from "../api";
import type {
  AgentStatus,
  ApplicationView,
  Deployment,
  PolicyResult,
  RouteSnapshot,
  RoutingTargetHealth,
  RoutingTargetView,
} from "../api/types";
import { Icon } from "../components/Icon";
import { Bool, Card, Empty, ErrorNote, Fields, Loading, Mono, Pill } from "../components/ui";
import { usePolling } from "../hooks";
import { detectRouteChange, markOf, type RouteChange, type RouteMark } from "../lib/failover";
import { formatTime, short, shortDigest, targetLabel, timeAgo } from "../lib/format";
import type { Tone } from "../lib/deployStatus";
import type { IconName } from "../lib/icons";
import { mockControls } from "../mocks/mockApi";
import { href } from "../router";

const POLL_MS = 4000;

interface Live {
  route: RouteSnapshot | null;
  targets: RoutingTargetView[];
  deployments: Deployment[];
  agents: AgentStatus[];
  policy: PolicyResult | null;
}

const HEALTH: Record<RoutingTargetHealth["status"], [Tone, IconName, string]> = {
  healthy: ["success", "check", "healthy"],
  unhealthy: ["danger", "x", "unhealthy"],
  unknown: ["neutral", "minus", "unknown"],
};

const DEPLOY_STATUS: Record<Deployment["status"], [Tone, IconName, string]> = {
  queued: ["neutral", "clock", "대기열"],
  running: ["info", "spinner", "진행 중"],
  awaiting_approval: ["warning", "clock", "승인 대기"],
  blocked: ["danger", "shield", "차단"],
  failed: ["danger", "x", "실패"],
  succeeded: ["success", "check", "완료"],
};

function HealthPill({ health }: { health: RoutingTargetHealth | null }) {
  const [tone, icon, label] = HEALTH[health?.status ?? "unknown"];
  return (
    <Pill tone={tone} icon={icon}>
      {health ? label : "기록 없음"}
    </Pill>
  );
}

function AgentPill({ status }: { status: AgentStatus["status"] }) {
  const map: Record<AgentStatus["status"], [Tone, IconName]> = {
    online: ["success", "check"],
    offline: ["danger", "x"],
    registered: ["neutral", "minus"],
    revoked: ["neutral", "lock"],
  };
  const [tone, icon] = map[status];
  return (
    <Pill tone={tone} icon={icon}>
      {status}
    </Pill>
  );
}

export function ApplicationDetail({ id }: { id: string }) {
  const app = usePolling(() => api.getApplication(id), null, id);
  const policyCache = useRef(new Map<string, PolicyResult | null>());

  const agentIds = app.data?.agents.map((agent) => agent.id) ?? [];
  const live = usePolling<Live>(
    async () => {
      const [route, targets, deployments, agents] = await Promise.all([
        api.getRouting(id),
        api.listTargets(id),
        api.listDeployments(id),
        Promise.all(agentIds.map((agentId) => api.agentStatus(agentId))),
      ]);
      // failover 가능 여부는 현재 경로 배포의 정책 결과. 배포마다 한 번만 가져옴
      let policy: PolicyResult | null = null;
      if (route) {
        const deploymentId = route.target.deploymentId;
        if (!policyCache.current.has(deploymentId)) {
          policyCache.current.set(deploymentId, (await api.getDeployment(deploymentId)).policyResult);
        }
        policy = policyCache.current.get(deploymentId) ?? null;
      }
      return { route, targets, deployments, agents, policy };
    },
    app.data ? POLL_MS : null,
    `${id}:${agentIds.join(",")}`,
  );

  // 이력 API 가 없으니 화면에서 본 직전 revision 을 기억
  const previous = useRef<RouteMark | null>(null);
  const [change, setChange] = useState<RouteChange | null>(null);
  useEffect(() => {
    if (!live.data) return;
    const current = markOf(live.data.route);
    const detected = detectRouteChange(previous.current, current);
    if (detected) setChange(detected);
    if (current) previous.current = current;
  }, [live.data]);

  if (app.loading) return <Loading />;
  if (!app.data) return <ErrorNote error={app.error} />;

  return (
    <div className="stack">
      <div className="crumbs">
        <a href={href.home()}>앱</a>
        <span>/</span>
        <span>{app.data.application.name}</span>
      </div>
      <div className="page-head row-between">
        <div>
          <h1>{app.data.application.name}</h1>
          <p className="sub">
            {app.data.application.publicHost && <Mono>{app.data.application.publicHost}</Mono>}
            <span className="live"> · {POLL_MS / 1000}초마다 갱신</span>
          </p>
        </div>
        {MOCK && <MockControls />}
      </div>
      <ErrorNote error={live.error} />
      {change && <ChangeBanner change={change} deployments={live.data?.deployments ?? []} onClose={() => setChange(null)} />}
      {!live.data ? (
        <Loading />
      ) : (
        <>
          <TrafficCard live={live.data} />
          <div className="grid-2">
            <TargetsCard live={live.data} />
            <AgentsCard app={app.data} live={live.data} />
          </div>
          <DeploymentsCard deployments={live.data.deployments} live={live.data} />
        </>
      )}
    </div>
  );
}

function MockControls() {
  const [failing, setFailing] = useState(mockControls.onpremFailing());
  return (
    <div className="mock-controls">
      <span className="mock-badge small">MOCK 조작</span>
      <button
        className="btn danger"
        type="button"
        disabled={failing}
        onClick={() => {
          mockControls.failOnprem();
          setFailing(true);
        }}
      >
        On-Prem 장애 재현
      </button>
      <button
        className="btn"
        type="button"
        onClick={() => {
          mockControls.reset();
          window.location.reload();
        }}
      >
        초기화
      </button>
    </div>
  );
}

function versionOf(deployments: Deployment[], deploymentId: string): string {
  const found = deployments.find((d) => d.id === deploymentId);
  return found ? `v${found.version}` : short(deploymentId, 8);
}

function ChangeBanner({
  change,
  deployments,
  onClose,
}: {
  change: RouteChange;
  deployments: Deployment[];
  onClose: () => void;
}) {
  return (
    <div className={`banner big ${change.failover ? "tone-warning" : "tone-info"}`} role="status">
      <Icon name={change.failover ? "alert" : "arrow"} size={20} />
      <div className="banner-body">
        <strong>{change.failover ? "failover 발생" : "트래픽 경로 바뀜"}</strong>
        <span>
          {targetLabel(change.from.kind)} ({versionOf(deployments, change.from.deploymentId)}, rev {change.from.revision})
          {" → "}
          {targetLabel(change.to.kind)} ({versionOf(deployments, change.to.deploymentId)}, rev {change.to.revision})
        </span>
        {change.failover && <span className="small">자동 failback 없음. On-Prem이 돌아와도 경로는 그대로</span>}
      </div>
      <button className="btn ghost" type="button" onClick={onClose} aria-label="닫기">
        <Icon name="x" />
      </button>
    </div>
  );
}

function TrafficCard({ live }: { live: Live }) {
  const { route, targets, deployments, policy } = live;
  if (!route) {
    return (
      <Card title="현재 트래픽">
        <div className="traffic-empty">
          <Icon name="minus" size={20} />
          <div>
            <strong>경로 없음</strong>
            <p className="small muted">아직 첫 전환 전 (GET /routing 404)</p>
          </div>
        </div>
      </Card>
    );
  }
  const current = route.target;
  const standby = targets.find(
    (item) => item.target.id !== current.id && item.target.deploymentId === current.deploymentId && item.target.enabled,
  );
  const kindIcon = (kind: string): IconName => (kind === "onprem" ? "server" : "cloud");
  return (
    <Card title="현재 트래픽" aside={<span className="muted small">route rev {route.revision}</span>}>
      <div className="traffic">
        <div className="traffic-main">
          <span className={`traffic-icon kind-${current.kind}`}>
            <Icon name={kindIcon(current.kind)} size={28} />
          </span>
          <div>
            <div className="traffic-kind">{targetLabel(current.kind)}</div>
            <div className="inline small">
              <a href={href.deployment(current.deploymentId)}>{versionOf(deployments, current.deploymentId)}</a>
              <HealthPill health={route.health} />
            </div>
            <div className="small muted">
              {current.kind === "onprem" ? `agent ${short(current.agentId, 8)} · port ${current.localPort ?? "-"}` : current.url}
            </div>
          </div>
        </div>
        <div className="traffic-side">
          <div className="side-label">대기 (standby)</div>
          {standby ? (
            <div className="inline">
              <Icon name={kindIcon(standby.target.kind)} />
              <span>{targetLabel(standby.target.kind)}</span>
              <HealthPill health={standby.health} />
            </div>
          ) : (
            <span className="muted">없음</span>
          )}
          <div className="side-label">failover</div>
          {policy ? (
            <Bool value={policy.failoverAllowed} yes="허용 (정책)" no="막힘 (정책)" />
          ) : (
            <span className="muted">정책 결과 없음</span>
          )}
        </div>
      </div>
    </Card>
  );
}

function TargetsCard({ live }: { live: Live }) {
  const { targets, route, deployments } = live;
  return (
    <Card title="대상별 상태">
      {targets.length === 0 ? (
        <Empty>등록된 대상 없음</Empty>
      ) : (
        <ul className="targets">
          {targets.map(({ target, health }) => (
            <li key={target.id} className={route?.target.id === target.id ? "is-current" : ""}>
              <div className="row-between">
                <span className="inline">
                  <Icon name={target.kind === "onprem" ? "server" : "cloud"} />
                  <strong>{targetLabel(target.kind)}</strong>
                  <a className="small" href={href.deployment(target.deploymentId)}>
                    {versionOf(deployments, target.deploymentId)}
                  </a>
                  {route?.target.id === target.id && <span className="tag">현재</span>}
                  {!target.enabled && <span className="tag">비활성</span>}
                </span>
                <HealthPill health={health} />
              </div>
              {health && (health.reason || health.failureKind || health.consecutiveFailures > 0) && (
                <div className="small muted target-detail">
                  {health.failureKind && <span className="tag">{health.failureKind === "network" ? "network (연결)" : "application (앱 응답)"}</span>}
                  {health.reason && <Mono>{health.reason}</Mono>}
                  {health.consecutiveFailures > 0 && <span>연속 실패 {health.consecutiveFailures}</span>}
                </div>
              )}
              {health && <div className="small muted">확인 {timeAgo(health.observedAt)}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AgentsCard({ app, live }: { app: ApplicationView; live: Live }) {
  const currentDeployment = live.route?.target.deploymentId;
  return (
    <Card title="On-Prem Agent">
      {app.agents.length === 0 ? (
        <Empty>할당된 Agent 없음 (POST /applications/:id/agents/:agentId)</Empty>
      ) : (
        <ul className="targets">
          {app.agents.map((agent) => {
            const status = live.agents.find((item) => item.agent_id === agent.id);
            const serving = status?.serving;
            return (
              <li key={agent.id}>
                <div className="row-between">
                  <span className="inline">
                    <Icon name="server" />
                    <strong>{agent.name}</strong>
                  </span>
                  {status && <AgentPill status={status.status} />}
                </div>
                <Fields
                  items={[
                    ["마지막 연결", status?.last_seen_at ? `${timeAgo(status.last_seen_at)} (${formatTime(status.last_seen_at)})` : "-"],
                    [
                      "서빙 중",
                      serving ? (
                        <span className="stack-xs">
                          <span className="inline">
                            <a href={href.deployment(serving.run_id)}>{versionOf(live.deployments, serving.run_id)}</a>
                            <Mono>{shortDigest(serving.digest)}</Mono>
                            {currentDeployment === serving.run_id && <span className="tag">현재 경로 버전</span>}
                          </span>
                          <Mono>{serving.container}</Mono>
                        </span>
                      ) : (
                        "없음"
                      ),
                    ],
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DeploymentsCard({ deployments, live }: { deployments: Deployment[]; live: Live }) {
  return (
    <Card title="배포 기록">
      {deployments.length === 0 ? (
        <Empty>배포 없음</Empty>
      ) : (
        <div className="deploy-list">
          {deployments.map((d) => {
            const [tone, icon, label] = DEPLOY_STATUS[d.status];
            const isCurrent = live.route?.target.deploymentId === d.id;
            return (
              <a key={d.id} className="deploy-row" href={href.deployment(d.id)}>
                <span className="deploy-version">v{d.version}</span>
                <Pill tone={tone} icon={icon}>
                  {d.status === "succeeded" && !d.deploymentPerformed ? "완료 (배포 생략)" : label}
                </Pill>
                <span className="deploy-meta">
                  <Mono>{short(d.sourceRevision, 7)}</Mono>
                  <span className="muted small">{formatTime(d.createdAt)}</span>
                  {isCurrent && <span className="tag">트래픽 받는 중</span>}
                </span>
                <Icon name="arrow" className="muted" />
              </a>
            );
          })}
        </div>
      )}
    </Card>
  );
}
