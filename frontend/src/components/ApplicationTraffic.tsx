import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DataSource } from "../api/client";
import type { ApplicationSnapshot } from "../pages/ApplicationDetail";
import { usePolling } from "../hooks/usePolling";
import { useLang } from "../lib/i18n";
import { fmtTime, targetLabel } from "../lib/format";
import { ErrorNotice } from "./ErrorNotice";
import { Empty, Pill } from "./ui";
export function ApplicationTraffic({
  id,
  source,
  snap,
  onChanged,
}: {
  id: string;
  source: DataSource;
  snap: ApplicationSnapshot;
  onChanged: () => void;
}) {
  const { lang } = useLang();
  const copy = (ko: string, ja: string) => (lang === "ko" ? ko : ja);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<unknown>(null);
  const [switchTarget, setSwitchTarget] = useState("");
  const [switched, setSwitched] = useState(false);
  const [seconds, setSeconds] = useState(300);
  const poll = usePolling(() => source.getTraffic(id, seconds), 5000, [
    id,
    source,
    seconds,
  ]);
  const changes = usePolling(() => source.getRoutingHistory(id), 5000, [
    id,
    source,
  ]);
  const data = poll.loading ? null : poll.data;
  const activeId = snap.route?.target.id;
  const current = snap.targets.find((t) => t.target.id === activeId);
  const others = snap.targets.filter(
    (t) =>
      t.target.enabled &&
      t.target.id !== activeId &&
      t.target.deploymentId === snap.route?.target.deploymentId,
  );
  const routedTargets = current
    ? [current, ...others]
    : snap.route
      ? [{ target: snap.route.target, health: snap.route.health }, ...others]
      : [];
  const { nodes, edges } = useMemo(() => {
    const healthEnabled = snap.app.healthCheck.enabled;
    const nodes: Node[] = [
      {
        id: "public",
        type: "input",
        position: { x: 0, y: Math.max(0, (routedTargets.length - 1) * 75) },
        sourcePosition: Position.Right,
        data: {
          label: (
            <>
              <strong>
                {copy("Hibiscus 공개 주소", "Hibiscus公開アドレス")}
              </strong>
              <div>{snap.app.application.publicHost ?? "—"}</div>
              <div>
                {data
                  ? `${data.requestsPerSecond.toFixed(1)}${copy("건/초", "件/秒")}`
                  : "—"}
              </div>
            </>
          ),
        },
      },
    ];
    const edges: Edge[] = [];
    for (const [i, item] of routedTargets.entries()) {
      const version = snap.deployments.find(
        (d) => d.id === item.target.deploymentId,
      )?.version;
      const isActive = item.target.id === activeId;
      const health =
        item.health && Date.parse(item.health.expiresAt) > Date.now()
          ? item.health.status
          : "unknown";
      const rate =
        data?.targets.find((t) => t.targetId === item.target.id)
          ?.requestsPerSecond ?? 0;
      nodes.push({
        id: item.target.id,
        type: "output",
        position: { x: 420, y: i * 170 },
        targetPosition: Position.Left,
        data: {
          label: (
            <>
              <strong>
                {targetLabel(item.target.kind)} ·{" "}
                {version !== undefined ? `v${version}` : "—"}
              </strong>
              <div>
                {isActive
                  ? copy("현재 서비스", "現在のサービス")
                  : copy("대기", "待機")}{" "}
                ·{" "}
                {!healthEnabled
                  ? copy("확인 안 함", "未確認")
                  : health === "healthy"
                    ? copy("정상", "正常")
                    : health === "unhealthy"
                      ? copy("장애", "障害")
                      : copy("상태 미확인", "状態不明")}
              </div>
              <small>
                {data ? `${rate.toFixed(1)}${copy("건/초", "件/秒")}` : "—"} ·{" "}
                {item.health?.observedAt
                  ? fmtTime(item.health.observedAt)
                  : "—"}
              </small>
            </>
          ),
        },
        style: {
          width: 235,
          borderRadius: 10,
          borderColor: isActive ? "#44736a" : "#ccd6d0",
          background: isActive ? "#f1f8f4" : "white",
          padding: 16,
          color: "#2f3e46",
          lineHeight: 1.8,
        },
      });
      edges.push({
        id: `route-${item.target.id}`,
        source: "public",
        target: item.target.id,
        animated: isActive && rate > 0,
        label: isActive
          ? `${copy("현재", "現在")} · ${data ? rate.toFixed(1) : "—"}${copy("건/초", "件/秒")}`
          : copy("대기", "待機"),
        style: {
          stroke: isActive ? "#44736a" : "#a5b1ae",
          strokeWidth: isActive ? 2 : 1,
          strokeDasharray: isActive ? undefined : "5 5",
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? "#44736a" : "#a5b1ae",
        },
      });
    }
    return { nodes, edges };
  }, [snap, data, lang]);
  const switchCandidates = snap.targets.filter(
    (t) =>
      t.target.enabled &&
      t.target.id !== activeId &&
      t.target.deploymentId === snap.route?.target.deploymentId &&
      snap.deployments.some(
        (d) => d.id === t.target.deploymentId && d.status === "succeeded",
      ),
  );
  const targetName = (targetId: string | null) => {
    const target = snap.targets.find((t) => t.target.id === targetId)?.target;
    const version = snap.deployments.find(
      (d) => d.id === target?.deploymentId,
    )?.version;
    return target ? `${targetLabel(target.kind)} · v${version ?? "—"}` : "—";
  };
  const maxRate = Math.max(
    1,
    ...(data?.buckets.map((b) => b.requestsPerSecond) ?? []),
  );
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{copy("서비스 경로", "サービス経路")}</h2>
          <Pill tone={snap.route ? "success" : "muted"}>
            {snap.route
              ? copy("서비스 중", "稼働中")
              : copy("경로 없음", "経路なし")}
          </Pill>
        </div>
        {snap.route ? (
          <div className="service-flow">
            <ReactFlow
              key={`${activeId}:${routedTargets.length}`}
              nodes={nodes}
              edges={edges}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              minZoom={0.3}
              maxZoom={1.5}
            >
              <Background gap={20} color="#d9e0dc" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        ) : (
          <Empty>
            {copy(
              "배포 후 서비스 경로를 표시합니다.",
              "デプロイ後にサービス経路を表示します。",
            )}
          </Empty>
        )}
      </section>
      <section className="card">
        <h2 className="card-title">
          {copy("트래픽 전환", "トラフィック切替")}
        </h2>
        <div className="console-toolbar">
          <select
            className="input"
            aria-label={copy("전환 대상", "切替対象")}
            value={switchTarget}
            disabled={switching}
            onChange={(e) => {
              setSwitchTarget(e.target.value);
              setSwitched(false);
            }}
          >
            <option value="">{copy("대상 선택", "対象を選択")}</option>
            {switchCandidates.map((t) => (
              <option key={t.target.id} value={t.target.id}>
                {targetName(t.target.id)} · {t.health?.status ?? "unknown"}
              </option>
            ))}
          </select>
          <button
            className="btn btn-small"
            disabled={!switchTarget || switching}
            onClick={async () => {
              if (
                !window.confirm(
                  copy(
                    `공개 요청을 ${targetName(switchTarget)} 대상으로 전환하시겠습니까?`,
                    `${targetName(switchTarget)}に切り替えますか？`,
                  ),
                )
              )
                return;
              setSwitching(true);
              setSwitchError(null);
              setSwitched(false);
              try {
                await source.changeRouting(
                  id,
                  switchTarget,
                  snap.route?.revision ?? 0,
                );
                setSwitchTarget("");
                setSwitched(true);
                onChanged();
                changes.refresh();
                poll.refresh();
              } catch (e) {
                setSwitchError(e);
                onChanged();
              } finally {
                setSwitching(false);
              }
            }}
          >
            {copy(
              switching ? "전환 중…" : "트래픽 전환",
              switching ? "切替中…" : "トラフィック切替",
            )}
          </button>
        </div>
        {!switchCandidates.length && (
          <p className="small muted">
            {copy(
              "전환할 배포 대상이 없습니다.",
              "切替可能な対象がありません。",
            )}
          </p>
        )}
        <ErrorNotice error={switchError} />
        {switched && (
          <p className="small">
            {copy("트래픽을 전환했습니다.", "トラフィックを切り替えました。")}
          </p>
        )}
      </section>
      <div className="card-head">
        <h2 className="card-title">{copy("요청 지표", "リクエスト指標")}</h2>
        <select
          className="input"
          value={seconds}
          aria-label={copy("트래픽 집계 기간", "トラフィック集計期間")}
          onChange={(e) => setSeconds(Number(e.target.value))}
        >
          {[60, 300, 900].map((s) => (
            <option key={s} value={s}>
              {copy("최근", "直近")} {s / 60}
              {copy("분", "分")}
            </option>
          ))}
        </select>
      </div>
      <ErrorNotice error={poll.error} />
      <div className="console-metrics">
        {[
          [
            copy("완료 요청", "完了リクエスト"),
            data?.requests.toLocaleString() ?? "—",
            copy("기간 내 완료 요청", "期間内の完了数"),
          ],
          [
            copy("초당 요청", "毎秒のリクエスト"),
            data
              ? `${data.requestsPerSecond.toFixed(1)}${copy("건/초", "件/秒")}`
              : "—",
            `${copy("관측", "観測")} ${data?.observedSeconds ?? 0}${copy("초 평균", "秒の平均")}`,
          ],
          [
            copy("5xx 오류율", "5xxエラー率"),
            data ? `${(data.errorRate * 100).toFixed(1)}%` : "—",
            `${data?.errors ?? 0} / ${data?.requests ?? 0}`,
          ],
          [
            "p95",
            data?.p95Ms !== null && data?.p95Ms !== undefined
              ? `${Math.round(data.p95Ms)} ms`
              : "—",
            copy("응답 시간 · 표본 기반", "応答時間 · サンプル基準"),
          ],
        ].map(([label, value, hint]) => (
          <section className="card" key={label}>
            <div className="small muted">{label}</div>
            <div className="console-metric-value">{value}</div>
            <div className="small muted">{hint}</div>
          </section>
        ))}
      </div>
      <section className="card">
        <h2 className="card-title">
          {copy("초당 요청 추이", "毎秒リクエストの推移")}
        </h2>
        <div
          className="console-rate-chart"
          aria-label={copy("초당 요청 막대그래프", "毎秒リクエストの棒グラフ")}
          role="img"
        >
          {data?.buckets.map((b) => (
            <div
              key={b.timestamp}
              style={{
                height: `${Math.max(1, (b.requestsPerSecond / maxRate) * 100)}%`,
              }}
              title={`${fmtTime(b.timestamp)} · ${b.requestsPerSecond.toFixed(1)}${copy("건/초", "件/秒")} · ${b.requests}${copy("건", "件")}`}
            />
          ))}
        </div>
      </section>
      <section className="card">
        <h2 className="card-title">{copy("경로 전환 이력", "経路切替履歴")}</h2>
        <ErrorNotice error={changes.error} />
        {changes.data?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {[
                    copy("시각", "時刻"),
                    copy("이전 대상", "以前の対象"),
                    copy("현재 대상", "現在の対象"),
                    copy("사유", "理由"),
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {changes.data.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtTime(c.createdAt)}</td>
                    <td>{targetName(c.previousTargetId)}</td>
                    <td>{targetName(c.targetId)}</td>
                    <td>{c.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {copy("경로 전환 이력이 없습니다.", "切替履歴はありません。")}
          </Empty>
        )}
      </section>
    </div>
  );
}
