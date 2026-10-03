import type { DataSource } from "../api/client";
import type {
  AgentStatusResponse,
  AgentSummary,
  AgentTunnelStatus,
} from "../api/types";
import { usePolling } from "../hooks/usePolling";
import { useLang } from "../lib/i18n";
import { fmtTime } from "../lib/format";
import { hrefFor, applicationPath, deploymentPath } from "../lib/router";
import { Modal } from "./Modal";
import { ErrorNotice } from "./ErrorNotice";
import { Kv, Empty, Pill } from "./ui";
export function tunnelLabel(
  state: AgentTunnelStatus["state"] | undefined,
  lang: string,
) {
  const ko = {
    idle: "연결 불필요",
    connecting: "연결 중",
    connected: "연결됨",
    reconnecting: "재연결 중",
    disconnected: "끊김",
  };
  const ja = {
    idle: "接続不要",
    connecting: "接続中",
    connected: "接続済み",
    reconnecting: "再接続中",
    disconnected: "切断",
  };
  return state
    ? lang === "ko"
      ? ko[state]
      : ja[state]
    : lang === "ko"
      ? "확인 불가"
      : "確認不可";
}
function eventLabel(kind: string, lang: string) {
  const labels: Record<string, [string, string]> = {
    connected: ["SSH 연결", "SSH接続"],
    disconnected: ["SSH 종료", "SSH終了"],
    forward_opened: ["포워딩 열림", "転送開始"],
    forward_closed: ["포워딩 닫힘", "転送停止"],
    session_error: ["SSH 오류", "SSHエラー"],
    channel_error: ["요청 채널 오류", "リクエストチャネルエラー"],
    forward_error: ["포워딩 오류", "転送エラー"],
    agent_idle: ["연결 대기", "接続待機"],
    agent_connecting: ["연결 시도", "接続開始"],
    agent_connected: ["Agent 연결 보고", "Agent接続報告"],
    agent_reconnecting: ["재연결 시도", "再接続"],
    agent_disconnected: ["Agent 종료 보고", "Agent終了報告"],
  };
  return labels[kind]?.[lang === "ko" ? 0 : 1] ?? kind;
}
export function AgentConnectionDetails({
  agent,
  status,
  source,
  onClose,
}: {
  agent: AgentSummary;
  status: AgentStatusResponse | null;
  source: DataSource;
  onClose: () => void;
}) {
  const { lang } = useLang();
  const copy = (ko: string, ja: string) => (lang === "ko" ? ko : ja);
  const poll = usePolling(() => source.getAgentTunnel(agent.id), 5000, [
    source,
    agent.id,
  ]);
  const data = poll.error ? null : poll.data;
  return (
    <Modal
      title={`${agent.name} · ${copy("연결 상세", "接続詳細")}`}
      onClose={onClose}
    >
      <div className="stack">
        <ErrorNotice error={poll.error} />
        <Kv
          columns={2}
          items={[
            [
              "Agent",
              (status?.status ?? agent.status) === "online"
                ? copy("실행 중", "稼働中")
                : (status?.status ?? agent.status),
            ],
            ["SSH", tunnelLabel(data?.state, lang)],
            [
              copy("마지막 Heartbeat", "最終Heartbeat"),
              fmtTime(status?.last_seen_at ?? null),
            ],
            [
              copy("SSH 서버", "SSHサーバー"),
              data ? `${data.endpoint.host}:${data.endpoint.port}` : "—",
            ],
            [
              copy("연결 시각", "接続時刻"),
              fmtTime(data?.connected_at ?? null),
            ],
            [
              copy("연결 유지", "接続時間"),
              data?.connected ? `${data.uptime_seconds} s` : "—",
            ],
            [
              copy("포워딩", "転送"),
              data
                ? `${data.active_forwards} / ${data.requested_forwards}`
                : "—",
            ],
            [copy("재시도", "再試行"), data?.report?.retry_count ?? "—"],
            [
              copy("다음 재시도", "次の再試行"),
              fmtTime(data?.report?.next_retry_at ?? null),
            ],
            [
              copy("실행 정보", "実行情報"),
              data?.report
                ? `${data.report.platform} / ${data.report.arch} · v${data.report.version}`
                : "—",
            ],
            [
              copy("Agent 보고 시각", "Agent報告時刻"),
              fmtTime(data?.report_received_at ?? null),
            ],
            [
              copy("마지막 오류", "最終エラー"),
              data?.report?.last_error
                ? `${data.report.last_error_code ?? ""} · ${data.report.last_error} · ${fmtTime(data.report.last_error_at ?? null)}`
                : (data?.events.find((e) => e.code)?.message ?? "—"),
            ],
            [
              copy("서버 키 지문", "サーバー鍵指紋"),
              data?.endpoint.host_key_sha256 ?? "—",
            ],
          ]}
        />
        {data?.report_stale && (
          <p className="small">
            {copy(
              "Agent 연결 보고가 오래되었습니다.",
              "Agent接続報告が古くなっています。",
            )}
          </p>
        )}
        <section>
          <h3>{copy("포워딩 대상", "転送対象")}</h3>
          {data?.forwards.length ? (
            <div className="table-wrap">
              <table className="table small">
                <thead>
                  <tr>
                    <th>{copy("배포", "デプロイ")}</th>
                    <th>Gateway → App</th>
                    <th>SSH</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  {data.forwards.map((f) => (
                    <tr key={f.target_id}>
                      <td>
                        <a href={hrefFor(applicationPath(f.application_id))}>
                          {f.application_id.slice(0, 8)}
                        </a>{" "}
                        ·{" "}
                        <a href={hrefFor(deploymentPath(f.deployment_id))}>
                          {f.deployment_id.slice(0, 8)}
                        </a>
                      </td>
                      <td>
                        {f.gateway_port} → {f.local_port}
                      </td>
                      <td>
                        <Pill tone={f.connected ? "success" : "danger"}>
                          {copy(
                            f.connected ? "열림" : "닫힘",
                            f.connected ? "開" : "閉",
                          )}
                        </Pill>
                      </td>
                      <td>
                        {f.health && Date.parse(f.health.expiresAt) > Date.now()
                          ? f.health.status
                          : "unknown"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              {copy("포워딩 대상이 없습니다.", "転送対象はありません。")}
            </Empty>
          )}
        </section>
        <section>
          <h3>{copy("연결 이력", "接続履歴")}</h3>
          {data?.events.length ? (
            <div className="agent-connection-events">
              {data.events.map((e) => (
                <div className="agent-connection-event" key={e.id}>
                  <time>{fmtTime(e.createdAt)}</time>
                  <strong>{eventLabel(e.kind, lang)}</strong>
                  <span>
                    {e.code ?? ""}
                    {e.port ? ` · ${e.port}` : ""}
                  </span>
                  <span>{e.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>
              {copy("연결 기록이 없습니다.", "接続記録はありません。")}
            </Empty>
          )}
        </section>
      </div>
    </Modal>
  );
}
