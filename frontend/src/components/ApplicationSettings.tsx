import { useEffect, useMemo, useState } from "react";
import type { DataSource } from "../api/client";
import type {
  ApplicationView,
  Deployment,
  SettingsEnvironmentInput,
} from "../api/types";
import { ApplicationAgentConnection } from "./ApplicationAgentConnection";
import { ErrorNotice } from "./ErrorNotice";
import {
  healthCheckDraft,
  toHealthCheckInput,
  validateHealthCheck,
  type HealthCheckDraft,
} from "../lib/healthCheck";
import { deploymentPath, navigate } from "../lib/router";
import { useLang } from "../lib/i18n";
import {
  prepareSettingsEnvironment,
  settingsDeploymentRevision,
  type SettingsRow,
} from "../lib/settings";
export function ApplicationSettings({
  app,
  deployments,
  servingDeploymentId,
  source,
  onSaved,
}: {
  app: ApplicationView;
  deployments: Deployment[];
  servingDeploymentId?: string;
  source: DataSource;
  onSaved: () => void;
}) {
  const { lang, t } = useLang();
  const label = (ko: string, ja: string) => (lang === "ko" ? ko : ja);
  const [health, setHealth] = useState(() => healthCheckDraft(app.healthCheck));
  const [runtime, setRuntime] = useState<SettingsRow[]>(() =>
    (app.environment ?? []).map((name) => ({ name, value: "", stored: true })),
  );
  const [test, setTest] = useState<SettingsRow[]>(() =>
    (app.testEnvironment ?? []).map((name) => ({
      name,
      value: "",
      stored: true,
    })),
  );
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState("");
  const [bulk, setBulk] = useState<"runtime" | "test" | null>(null),
    [bulkText, setBulkText] = useState("");
  const healthErrors = useMemo(() => validateHealthCheck(health), [health]);
  const changeHealth = <K extends keyof HealthCheckDraft>(
    key: K,
    value: HealthCheckDraft[K],
  ) => {
    setHealth((h) => ({ ...h, [key]: value }));
    setDirty(true);
    setMessage("");
  };
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest("a[href]");
      if (
        anchor &&
        !anchor.getAttribute("href")?.startsWith("https:") &&
        !window.confirm(
          label(
            "저장하지 않은 변경을 버리고 이동할까요?",
            "未保存の変更を破棄しますか？",
          ),
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, lang]);
  const reset = () => {
    setHealth(healthCheckDraft(app.healthCheck));
    setRuntime(
      (app.environment ?? []).map((name) => ({
        name,
        value: "",
        stored: true,
      })),
    );
    setTest(
      (app.testEnvironment ?? []).map((name) => ({
        name,
        value: "",
        stored: true,
      })),
    );
    setDirty(false);
    setError(null);
    setMessage("");
  };
  const save = async (deploy: boolean) => {
    setError(null);
    setMessage("");
    if (Object.keys(healthErrors).length) {
      setError(
        new Error(
          label(
            "Health Check 입력 범위를 확인하세요.",
            "Health Checkの入力範囲を確認してください。",
          ),
        ),
      );
      return;
    }
    let environment: SettingsEnvironmentInput[],
      testEnvironment: SettingsEnvironmentInput[];
    try {
      environment = prepareSettingsEnvironment(runtime);
      testEnvironment = prepareSettingsEnvironment(test);
    } catch (e) {
      setError(e);
      return;
    }
    setBusy(true);
    let saved = false;
    try {
      const revision = deploy
        ? settingsDeploymentRevision(deployments, servingDeploymentId)
        : undefined;
      const updated = await source.updateApplicationSettings(
        app.application.id,
        {
          health_check: toHealthCheckInput(health),
          environment,
          test_environment: testEnvironment,
        },
      );
      saved = true;
      setRuntime(
        (updated.environment ?? []).map((name) => ({
          name,
          value: "",
          stored: true,
        })),
      );
      setTest(
        (updated.testEnvironment ?? []).map((name) => ({
          name,
          value: "",
          stored: true,
        })),
      );
      setHealth(healthCheckDraft(updated.healthCheck));
      setDirty(false);
      onSaved();
      if (deploy) {
        const created = await source.createDeployment(app.application.id, {
          source_revision: revision!,
        });
        navigate(deploymentPath(created.id));
      } else
        setMessage(
          label(
            "설정을 저장했습니다. 환경변수는 다음 배포에 적용됩니다.",
            "設定を保存しました。環境変数は次のデプロイに適用されます。",
          ),
        );
    } catch (e) {
      if (saved)
        setMessage(
          label(
            "설정은 저장했습니다. 배포 시작에 실패했습니다.",
            "設定は保存済みです。デプロイを開始できませんでした。",
          ),
        );
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const field = (
    key: Exclude<keyof HealthCheckDraft, "enabled" | "method">,
    ko: string,
    ja: string,
    type = "number",
    min = 1,
    max = 300,
  ) => (
    <label className="form-field" key={key}>
      <span className="field-label">{label(ko, ja)}</span>
      <input
        className="input"
        type={type}
        min={min}
        max={max}
        value={health[key]}
        onChange={(e) => changeHealth(key, e.target.value)}
        disabled={busy}
      />
      {healthErrors[key] && (
        <span className="form-error">
          {label("입력 범위를 확인하세요.", "入力範囲を確認してください。")}
        </span>
      )}
    </label>
  );
  const envEditor = (
    kind: "runtime" | "test",
    rows: SettingsRow[],
    setRows: (rows: SettingsRow[]) => void,
  ) => (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          {kind === "runtime"
            ? label("런타임 환경변수", "ランタイム環境変数")
            : label("검증용 환경변수", "検証用環境変数")}
        </h2>
        <div className="row">
          <button
            className="btn btn-small"
            disabled={busy}
            onClick={() => {
              setBulk(kind);
              setBulkText("");
            }}
          >
            .env {label("붙여넣기", "貼り付け")}
          </button>
          <button
            className="btn btn-small"
            disabled={busy || rows.length >= 50}
            onClick={() => {
              setRows([...rows, { name: "", value: "", stored: false }]);
              setDirty(true);
            }}
          >
            {label("항목 추가", "追加")}
          </button>
        </div>
      </div>
      <p className="small muted">
        {label(
          "기존 값은 유지합니다. 입력한 값만 교체합니다. PORT는 앱 포트 설정을 사용합니다.",
          "既存の値は保持します。入力した値のみ置換します。PORTはアプリのポート設定を使用します。",
        )}
      </p>
      {rows.map((row, i) => (
        <div className="settings-env-row" key={i}>
          <input
            className="input mono"
            aria-label={`${kind} ${label("변수 이름", "変数名")} ${i + 1}`}
            readOnly={row.stored}
            maxLength={64}
            value={row.name}
            placeholder="NAME"
            disabled={busy}
            onChange={(e) => {
              setRows(
                rows.map((r, j) =>
                  j === i ? { ...r, name: e.target.value } : r,
                ),
              );
              setDirty(true);
            }}
          />
          <input
            className="input mono"
            type="password"
            autoComplete="new-password"
            aria-label={`${kind} ${label("변수 값", "値")} ${i + 1}`}
            maxLength={4096}
            placeholder={
              row.stored
                ? label("설정됨 · 입력하면 교체", "設定済み · 入力で置換")
                : label("값", "値")
            }
            value={row.value}
            disabled={busy}
            onChange={(e) => {
              setRows(
                rows.map((r, j) =>
                  j === i ? { ...r, value: e.target.value } : r,
                ),
              );
              setDirty(true);
            }}
          />
          <button
            className="btn btn-small"
            disabled={busy}
            aria-label={`${row.name || i + 1} ${label("삭제", "削除")}`}
            onClick={() => {
              setRows(rows.filter((_, j) => i !== j));
              setDirty(true);
            }}
          >
            {label("삭제", "削除")}
          </button>
        </div>
      ))}
      {!rows.length && (
        <p className="small muted">
          {label("설정한 환경변수가 없습니다.", "環境変数はありません。")}
        </p>
      )}
    </section>
  );
  const applyBulk = () => {
    try {
      const rows = bulk === "runtime" ? runtime : test;
      const next = [...rows];
      for (const raw of bulkText.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const i = line.indexOf("=");
        if (i < 1) throw new Error("NAME=value 형식으로 입력하세요.");
        const name = line.slice(0, i).trim();
        let value = line.slice(i + 1);
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        )
          value = value.slice(1, -1);
        const existing = next.findIndex((r) => r.name === name);
        if (existing >= 0) next[existing] = { ...next[existing]!, value };
        else next.push({ name, value, stored: false });
      }
      prepareSettingsEnvironment(next);
      if (bulk === "runtime") setRuntime(next);
      else setTest(next);
      setDirty(true);
      setBulk(null);
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="stack">
      <section className="card">
        <h2 className="card-title">{label("Agent 연결", "Agent接続")}</h2>
        <ApplicationAgentConnection
          id={app.application.id}
          source={source}
          app={app}
          onConnected={onSaved}
        />
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Health Check</h2>
          <label className="check-row">
            <input
              type="checkbox"
              checked={health.enabled}
              disabled={busy}
              onChange={(e) => changeHealth("enabled", e.target.checked)}
            />
            {label("사용", "使用")}
          </label>
        </div>
        <div className="form-grid">
          {field("path", "경로", "パス", "text")}
          {field(
            "versionPath",
            "버전 확인 경로 (선택)",
            "バージョン確認パス (任意)",
            "text",
          )}
          <label className="form-field">
            <span className="field-label">{label("메서드", "メソッド")}</span>
            <select
              className="input"
              value={health.method}
              disabled={busy}
              onChange={(e) =>
                changeHealth("method", e.target.value as "GET" | "HEAD")
              }
            >
              <option>GET</option>
              <option>HEAD</option>
            </select>
          </label>
          {field("intervalSeconds", "확인 주기 (초)", "確認間隔 (秒)")}
          {field(
            "timeoutSeconds",
            "제한 시간 (초)",
            "タイムアウト (秒)",
            "number",
            1,
            60,
          )}
          {field(
            "successStatusMin",
            "성공 상태 코드 시작",
            "成功ステータス最小",
            "number",
            100,
            599,
          )}
          {field(
            "successStatusMax",
            "성공 상태 코드 끝",
            "成功ステータス最大",
            "number",
            100,
            599,
          )}
          {field(
            "successThreshold",
            "정상 판정 연속 성공",
            "正常判定の連続成功",
            "number",
            1,
            20,
          )}
          {field(
            "failureThreshold",
            "장애 판정 연속 실패",
            "障害判定の連続失敗",
            "number",
            1,
            20,
          )}
        </div>
        <p className="small muted">
          {health.enabled
            ? label(
                "Health Check 설정은 저장하면 적용됩니다.",
                "Health Checkは保存後に適用されます。",
              )
            : label(
                "상태 확인과 Health Check에 따른 자동 장애 전환을 사용하지 않습니다.",
                "状態確認とHealth Checkによる自動切替を使用しません。",
              )}
        </p>
      </section>
      {envEditor("runtime", runtime, setRuntime)}
      {envEditor("test", test, setTest)}
      {bulk && (
        <section className="card">
          <h2 className="card-title">.env {label("붙여넣기", "貼り付け")}</h2>
          <textarea
            className="input mono"
            rows={6}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            aria-label=".env"
          />
          <div className="row">
            <button className="btn" onClick={applyBulk}>
              {label("적용", "適用")}
            </button>
            <button className="btn" onClick={() => setBulk(null)}>
              {t("cancel")}
            </button>
          </div>
        </section>
      )}
      <ErrorNotice error={error} />
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      <div className="settings-save-bar">
        <span className="small muted">
          {dirty
            ? label("저장하지 않은 변경", "未保存の変更")
            : label("저장된 설정", "保存済み")}
        </span>
        <div className="row">
          <button className="btn" disabled={busy || !dirty} onClick={reset}>
            {label("변경 취소", "変更取消")}
          </button>
          <button
            className="btn"
            disabled={busy || !dirty}
            onClick={() => void save(false)}
          >
            {busy ? t("saving") : t("save")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !deployments.length}
            onClick={() => void save(true)}
          >
            {label("저장 후 배포", "保存してデプロイ")}
          </button>
        </div>
      </div>
    </div>
  );
}
