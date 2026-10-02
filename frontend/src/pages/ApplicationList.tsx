import { api, MOCK } from "../api";
import type { ApplicationView } from "../api/types";
import { Icon } from "../components/Icon";
import { Card, Empty, ErrorNote, Loading, Pill } from "../components/ui";
import { usePolling } from "../hooks";
import { targetLabel } from "../lib/format";
import { href } from "../router";

function AppRow({ view }: { view: ApplicationView }) {
  const { application } = view;
  const route = usePolling(() => api.getRouting(application.id), 10_000, application.id);
  const kind = route.data?.target.kind;
  return (
    <a className="app-row" href={href.application(application.id)}>
      <span className="app-icon" aria-hidden="true">
        {application.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="app-main">
        <span className="app-name">{application.name}</span>
        <span className="app-host">{application.publicHost ?? application.slug}</span>
      </span>
      <span className="app-meta">
        {route.loading ? null : kind ? (
          <Pill tone="success" icon={kind === "onprem" ? "server" : "cloud"}>
            {targetLabel(kind)} · rev {route.data?.revision}
          </Pill>
        ) : (
          <Pill tone="neutral" icon="minus">
            경로 없음
          </Pill>
        )}
        <Icon name="arrow" className="muted" />
      </span>
    </a>
  );
}

export function ApplicationList() {
  const apps = usePolling(() => api.listApplications(), null, "apps");
  return (
    <div className="stack">
      <div className="page-head">
        <h1>애플리케이션</h1>
        <p className="sub">
          {MOCK ? "MOCK 데이터. guestbook 에서 failover, contacts 에서 승인 흐름을 볼 수 있음" : "백엔드에 등록된 앱"}
        </p>
      </div>
      <ErrorNote error={apps.error} />
      {apps.loading && <Loading />}
      {apps.data && (
        <Card>
          {apps.data.length === 0 ? (
            <Empty>등록된 앱 없음</Empty>
          ) : (
            <div className="app-list">
              {apps.data.map((view) => (
                <AppRow key={view.application.id} view={view} />
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
