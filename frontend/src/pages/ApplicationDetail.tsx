import { useState } from "react";
import { Plus } from "lucide-react";
import { ApiError, type DataSource } from "../api/client";
import type {
  ApplicationView,
  Deployment,
  RouteSnapshot,
  RoutingTargetView,
} from "../api/types";
import { PageError } from "../components/PageError";
import { Loader } from "../components/Loader";
import {
  Crumbs,
  Empty,
  Hash,
  PageTitle,
  Pill,
  type Tone,
} from "../components/ui";
import { NewDeploymentModal } from "../components/NewDeploymentModal";
import { usePolling } from "../hooks/usePolling";
import { fmtTime, targetLabel } from "../lib/format";
import { useLang } from "../lib/i18n";
import { isGithubSource } from "../lib/forms";
import {
  applicationPath,
  deploymentPath,
  hrefFor,
  navigate,
  APPLICATIONS_PATH,
  realHref,
} from "../lib/router";
import { ApplicationSettings } from "../components/ApplicationSettings";
import { ApplicationLogs } from "../components/ApplicationLogs";
import { ApplicationTraffic } from "../components/ApplicationTraffic";
export type ApplicationTab =
  "overview" | "deployments" | "logs" | "traffic" | "settings";
export interface ApplicationSnapshot {
  app: ApplicationView;
  route: RouteSnapshot | null;
  targets: RoutingTargetView[];
  deployments: Deployment[];
}
const statusTone: Record<Deployment["status"], Tone> = {
  queued: "info",
  running: "info",
  awaiting_approval: "warning",
  blocked: "danger",
  failed: "danger",
  succeeded: "success",
  cancelled: "muted",
};
const statusKey = {
  queued: "statusQueued",
  running: "statusRunning",
  awaiting_approval: "statusAwaiting",
  blocked: "statusBlocked",
  failed: "statusFailed",
  succeeded: "statusSucceeded",
  cancelled: "statusCancelled",
} as const;
export function ApplicationDetail({
  id,
  source,
  tab = "overview",
}: {
  id: string;
  source: DataSource;
  tab?: ApplicationTab;
}) {
  const { t, lang } = useLang();
  const [deployOpen, setDeployOpen] = useState(false);
  const poll = usePolling<ApplicationSnapshot>(
    async () => {
      const [app, route, targets, deployments] = await Promise.all([
        source.getApplication(id),
        source.getRouting(id).catch((error: unknown) => {
          if (error instanceof ApiError && error.isNotFound) return null;
          throw error;
        }),
        source.getTargets(id),
        source.listDeployments(id),
      ]);
      return {
        app,
        route,
        targets,
        deployments: deployments.sort((a, b) => b.version - a.version),
      };
    },
    5000,
    [id, source],
  );
  const activeRevision = poll.data?.deployments.find(
    (d) => d.id === poll.data?.route?.target.deploymentId,
  )?.sourceRevision;
  const currentCommit = usePolling(
    () =>
      poll.data?.app.application.repo && activeRevision
        ? source.listApplicationCommits(id, 1, activeRevision)
        : Promise.resolve(null),
    null,
    [source, id, activeRevision, poll.data?.app.application.repo],
  );
  if (!poll.data)
    return poll.error ? (
      <PageError error={poll.error} />
    ) : (
      <Loader label={t("loading")} />
    );
  const snap = poll.data;
  const a = snap.app.application;
  const current = snap.deployments.find(
    (d) => d.id === snap.route?.target.deploymentId,
  );
  const latest = snap.deployments[0];
  const tabs: Array<[ApplicationTab, string]> = [
    ["overview", lang === "ko" ? "개요" : "概要"],
    ["deployments", t("deployHistory")],
    ["logs", lang === "ko" ? "로그" : "ログ"],
    ["traffic", lang === "ko" ? "트래픽" : "トラフィック"],
    ["settings", lang === "ko" ? "배포 설정" : "デプロイ設定"],
  ];
  return (
    <div className="page">
      <PageTitle
        crumbs={
          <Crumbs
            items={[
              { label: t("crumbApps"), href: realHref(APPLICATIONS_PATH) },
              { label: a.name },
            ]}
          />
        }
        title={a.name}
        sub={
          <span className="small muted">
            {a.repo ?? a.slug} · {a.defaultBranch ?? "—"}
          </span>
        }
        right={
          <div className="row">
            <button
              className="btn btn-primary btn-small"
              onClick={() => setDeployOpen(true)}
            >
              <Plus size={14} />
              {t("newDeployment")}
            </button>
            <a
              className="btn btn-small"
              href={hrefFor(applicationPath(id) + "/settings")}
            >
              {lang === "ko" ? "배포 설정" : "デプロイ設定"}
            </a>
          </div>
        }
      />
      {deployOpen && (
        <NewDeploymentModal
          source={source}
          applicationId={id}
          requireFullSha={isGithubSource(a.sourcePath)}
          onClose={() => setDeployOpen(false)}
        />
      )}
      <nav
        className="console-tabs"
        aria-label={
          lang === "ko" ? "애플리케이션 메뉴" : "アプリケーションメニュー"
        }
      >
        {tabs.map(([key, label]) => (
          <a
            key={key}
            href={hrefFor(applicationPath(id) + "/" + key)}
            aria-current={tab === key ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {poll.error ? <PageError error={poll.error} compact /> : null}
      {tab === "overview" && (
        <>
          <section className="card">
            <h2 className="card-title">
              {lang === "ko" ? "도메인 · GitHub 연결" : "ドメイン・GitHub接続"}
            </h2>
            <dl className="facts">
              <div className="fact">
                <dt>{lang === "ko" ? "도메인" : "ドメイン"}</dt>
                <dd>
                  {a.publicHost ? (
                    <a
                      href={`${a.publicHost.endsWith(".localhost") ? "http" : "https"}://${a.publicHost}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.publicHost}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div className="fact">
                <dt>GitHub</dt>
                <dd>
                  {a.repo ? (
                    <a
                      href={`https://github.com/${a.repo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.repo}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div className="fact">
                <dt>{lang === "ko" ? "연결 브랜치" : "接続ブランチ"}</dt>
                <dd>{a.defaultBranch ?? "—"}</dd>
              </div>
              <div className="fact">
                <dt>{lang === "ko" ? "소스 경로" : "ソースパス"}</dt>
                <dd>{a.sourcePath}</dd>
              </div>
            </dl>
          </section>
          <div className="grid-2 overview-service-cards">
            <section className="card">
              <h2 className="card-title">
                {lang === "ko" ? "현재 서비스" : "現在のサービス"}
              </h2>
              {snap.route ? (
                <>
                  <div className="console-version">
                    {current ? `v${current.version}` : "—"} ·{" "}
                    {targetLabel(snap.route.target.kind)}
                  </div>
                  <dl className="facts">
                    <div className="fact">
                      <dt>{lang === "ko" ? "공개 주소" : "公開アドレス"}</dt>
                      <dd>
                        {a.publicHost ? (
                          <a
                            href={`${a.publicHost.endsWith(".localhost") ? "http" : "https"}://${a.publicHost}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {a.publicHost}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div className="fact">
                      <dt>
                        {lang === "ko" ? "서비스 커밋" : "サービスコミット"}
                      </dt>
                      <dd>
                        <Hash value={current?.sourceRevision ?? null} />
                        {currentCommit.data?.commits[0]?.sha ===
                          activeRevision && (
                          <div className="small" style={{ marginTop: 6 }}>
                            {
                              currentCommit.data?.commits[0]?.message.split(
                                "\n",
                              )[0]
                            }
                          </div>
                        )}
                      </dd>
                    </div>
                    <div className="fact">
                      <dt>Health Check</dt>
                      <dd>
                        {!snap.app.healthCheck.enabled
                          ? t("healthOff")
                          : snap.route.health &&
                              Date.parse(snap.route.health.expiresAt) >
                                Date.now()
                            ? snap.route.health.status
                            : t("unknown")}
                      </dd>
                    </div>
                  </dl>
                </>
              ) : (
                <Empty>{t("noRouteNote")}</Empty>
              )}
            </section>
            <section className="card">
              <h2 className="card-title">
                {lang === "ko" ? "최근 배포" : "最近のデプロイ"}
              </h2>
              {latest ? (
                <>
                  <div className="row">
                    <span className="console-version">v{latest.version}</span>
                    <Pill tone={statusTone[latest.status]}>
                      {t(statusKey[latest.status])}
                    </Pill>
                  </div>
                  <p className="small muted">
                    <Hash value={latest.sourceRevision} /> ·{" "}
                    {fmtTime(latest.createdAt)}
                  </p>
                  <a
                    className="btn btn-small"
                    href={hrefFor(deploymentPath(latest.id))}
                  >
                    {lang === "ko" ? "배포 상세 보기" : "デプロイ詳細"}
                  </a>
                </>
              ) : (
                <Empty>
                  {lang === "ko"
                    ? "배포 이력이 없습니다."
                    : "デプロイ履歴はありません。"}
                </Empty>
              )}
            </section>
          </div>
          <section className="card">
            <h2 className="card-title">{t("agent")}</h2>
            {snap.app.agents.length ? (
              <div className="console-agent-list">
                {snap.app.agents.map((agent) => (
                  <div className="row" key={agent.id}>
                    <strong>{agent.name}</strong>
                    <span className="small muted">
                      {agent.lastSeenAt ? fmtTime(agent.lastSeenAt) : "—"}
                    </span>
                    <Pill
                      tone={
                        agent.status === "online"
                          ? "success"
                          : agent.status === "offline"
                            ? "danger"
                            : "muted"
                      }
                    >
                      {agent.status}
                    </Pill>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>
                {lang === "ko"
                  ? "연결된 Agent가 없습니다."
                  : "接続されたAgentがありません。"}
              </Empty>
            )}
          </section>
        </>
      )}
      {tab === "deployments" && (
        <section className="card">
          <h2 className="card-title">{t("deployHistory")}</h2>
          {snap.deployments.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {(lang === "ko"
                      ? ["버전", "커밋", "시작 방식", "배포 결과", "시각"]
                      : ["バージョン", "コミット", "開始方式", "結果", "時刻"]
                    ).map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {snap.deployments.map((d) => (
                    <tr
                      key={d.id}
                      className="console-history-row"
                      onClick={(event) => {
                        if (!(event.target as Element).closest("button,a"))
                          navigate(deploymentPath(d.id));
                      }}
                    >
                      <td>
                        <a href={hrefFor(deploymentPath(d.id))}>v{d.version}</a>{" "}
                        {d.id === current?.id && (
                          <Pill tone="success">
                            {lang === "ko" ? "서비스 중" : "稼働中"}
                          </Pill>
                        )}
                      </td>
                      <td>
                        <Hash value={d.sourceRevision} />
                      </td>
                      <td>{d.trigger}</td>
                      <td>
                        <Pill tone={statusTone[d.status]}>
                          {t(statusKey[d.status])}
                        </Pill>
                      </td>
                      <td>{fmtTime(d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              {lang === "ko"
                ? "배포 이력이 없습니다."
                : "デプロイ履歴はありません。"}
            </Empty>
          )}
        </section>
      )}
      {tab === "logs" && (
        <ApplicationLogs key={id} id={id} source={source} snap={snap} />
      )}
      {tab === "traffic" && (
        <ApplicationTraffic
          id={id}
          source={source}
          snap={snap}
          onChanged={poll.refresh}
        />
      )}
      {tab === "settings" && (
        <ApplicationSettings
          key={id}
          source={source}
          app={snap.app}
          deployments={snap.deployments}
          servingDeploymentId={snap.route?.target.deploymentId}
          onSaved={poll.refresh}
        />
      )}
    </div>
  );
}
