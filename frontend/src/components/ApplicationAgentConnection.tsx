import { useState } from "react";
import type { DataSource } from "../api/client";
import type { ApplicationView } from "../api/types";
import { usePolling } from "../hooks/usePolling";
import { useLang } from "../lib/i18n";
import { ErrorNotice } from "./ErrorNotice";
import { hrefFor } from "../lib/router";
export function ApplicationAgentConnection({
  id,
  source,
  app,
  onConnected,
}: {
  id: string;
  source: DataSource;
  app: ApplicationView;
  onConnected: () => void;
}) {
  const { lang } = useLang();
  const copy = (ko: string, ja: string) => (lang === "ko" ? ko : ja);
  const agents = usePolling(() => source.listAgents(), 5000, [source]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const available =
    agents.data?.filter(
      (a) => a.status !== "revoked" && !app.agents.some((b) => b.id === a.id),
    ) ?? [];
  async function connect() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await source.assignApplicationAgent(id, selected);
      setSelected("");
      setSaved(true);
      onConnected();
      agents.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(agentId: string) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await source.unassignApplicationAgent(id, agentId);
      setSaved(true);
      onConnected();
      agents.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {app.agents.map((a) => (
        <div className="row" key={a.id}>
          <strong>{a.name}</strong>
          <span className="small muted">{a.status}</span>
          <button
            className="btn btn-small"
            disabled={busy}
            onClick={() => void disconnect(a.id)}
          >
            {copy("연결 해제", "接続解除")}
          </button>
        </div>
      ))}
      <div className="console-toolbar">
        <select
          className="input"
          aria-label={copy("연결할 Agent", "接続するAgent")}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy}
        >
          <option value="">{copy("Agent 선택", "Agentを選択")}</option>
          {available.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.status}
            </option>
          ))}
        </select>
        <button
          className="btn btn-small"
          disabled={!selected || busy}
          onClick={() => void connect()}
        >
          {copy(
            busy ? "연결 중…" : "Agent 연결",
            busy ? "接続中…" : "Agentを接続",
          )}
        </button>
        <a className="btn btn-small" href={hrefFor("/agents")}>
          {copy("Agent 등록·설치", "Agent登録・インストール")}
        </a>
      </div>
      <ErrorNotice error={error ?? agents.error} />
      {saved && (
        <p className="small">
          {copy(
            "다음 배포의 Agent 설정을 저장했습니다.",
            "Agentを接続しました。次のデプロイから使用します。",
          )}
        </p>
      )}
    </div>
  );
}
