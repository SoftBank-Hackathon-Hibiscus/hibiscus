import { useLayoutEffect, useRef, useState } from "react";
import type { DataSource } from "../api/client";
import type { TargetKind } from "../api/types";
import type { ApplicationSnapshot } from "../pages/ApplicationDetail";
import { usePolling } from "../hooks/usePolling";
import { useLang } from "../lib/i18n";
import { targetLabel, fmtTime } from "../lib/format";
import { ErrorNotice } from "./ErrorNotice";
import { Empty } from "./ui";
export function ApplicationLogs({
  id,
  source,
  snap,
}: {
  id: string;
  source: DataSource;
  snap: ApplicationSnapshot;
}) {
  const { lang } = useLang();
  const copy = (ko: string, ja: string) => (lang === "ko" ? ko : ja);
  const [deployment, setDeployment] = useState(
    snap.route?.target.deploymentId ?? snap.deployments[0]?.id ?? "",
  );
  const [target, setTarget] = useState<TargetKind>(
      snap.route?.target.kind ?? "onprem",
    ),
    [seconds, setSeconds] = useState(300),
    [level, setLevel] = useState("all"),
    [search, setSearch] = useState(""),
    [paused, setPaused] = useState(false);
  const poll = usePolling(
    () =>
      source.getApplicationLogs(id, {
        deployment_id: deployment || undefined,
        target,
        seconds,
        level,
        search,
      }),
    paused ? null : 5000,
    [id, source, deployment, target, seconds, level, search],
  );
  const terminalRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (terminal && autoScroll && !poll.loading && !poll.error) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }, [poll.data, poll.loading, poll.error, autoScroll]);
  // usePolling retains prior responses while loading. Never label them as another filter's results.
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          {copy("애플리케이션 로그", "アプリケーションログ")}
        </h2>
        <label className="row small">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          {copy("자동 스크롤", "自動スクロール")}
        </label>
        <button className="btn btn-small" onClick={() => setPaused(!paused)}>
          {paused
            ? copy("자동 갱신", "自動更新")
            : copy("일시 정지", "一時停止")}
        </button>
      </div>
      <div className="console-toolbar">
        <select
          className="input"
          aria-label={copy("로그 버전", "ログバージョン")}
          value={deployment}
          onChange={(e) => setDeployment(e.target.value)}
        >
          {snap.deployments.map((d) => (
            <option key={d.id} value={d.id}>
              v{d.version}
              {d.id === snap.route?.target.deploymentId
                ? copy(" · 서비스 중", " · 稼働中")
                : ""}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label={copy("로그 대상", "ログ対象")}
          value={target}
          onChange={(e) => setTarget(e.target.value as TargetKind)}
        >
          <option value="onprem">On-Prem</option>
          <option value="cloud_run">Cloud Run</option>
        </select>
        <select
          className="input"
          aria-label={copy("로그 기간", "ログ期間")}
          value={seconds}
          onChange={(e) => setSeconds(Number(e.target.value))}
        >
          {[300, 900, 3600].map((s) => (
            <option key={s} value={s}>
              {s / 60}
              {copy("분", "分")}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label={copy("로그 수준", "ログレベル")}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="all">{copy("모든 수준", "全レベル")}</option>
          <option>ERROR</option>
          <option>WARN</option>
          <option>INFO</option>
        </select>
        <input
          className="input"
          aria-label={copy("로그 검색", "ログ検索")}
          placeholder={copy("로그 검색", "ログ検索")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={200}
        />
      </div>
      <p className="small muted">
        {targetLabel(target)} · stdout / stderr{" "}
        {poll.data && !poll.loading ? `· ${fmtTime(poll.data.fetchedAt)}` : ""}
      </p>
      <ErrorNotice error={poll.error} />
      <div
        ref={terminalRef}
        className="runtime-log-terminal"
        role="log"
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
        }}
      >
        {poll.loading ? (
          <p>{copy("로그 조회 중…", "ログを取得中…")}</p>
        ) : poll.error ? (
          <p>
            {copy(
              "로그를 가져오지 못했습니다.",
              "ログを取得できませんでした。",
            )}
          </p>
        ) : poll.data?.entries.length ? (
          poll.data.entries.map((e) => (
            <div className="runtime-log-line" key={e.id}>
              <time>{fmtTime(e.timestamp)}</time>
              <span className={`log-level log-${e.level.toLowerCase()}`}>
                {e.level}
              </span>
              <span className="muted">{e.stream}</span>
              <span>{e.message}</span>
            </div>
          ))
        ) : (
          <Empty>
            {poll.data?.unavailable ??
              copy(
                "조건에 맞는 앱 로그가 없습니다.",
                "条件に一致するアプリログはありません。",
              )}
          </Empty>
        )}
      </div>
      <p className="small muted">
        {copy(
          "최대 150개. 배포 단계 로그는 배포 상세에서 확인하세요.",
          "最大150件。デプロイログはデプロイ詳細で確認できます。",
        )}
        {poll.data?.truncated &&
          copy(
            " 최근 150개만 표시합니다. 기간이나 검색 조건을 줄이세요.",
            " 最新150件のみ表示します。期間や検索条件を絞ってください。",
          )}
      </p>
    </section>
  );
}
