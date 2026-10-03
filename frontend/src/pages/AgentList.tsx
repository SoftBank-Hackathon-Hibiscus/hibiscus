import {
  AgentConnectionDetails,
  tunnelLabel,
} from "../components/AgentConnectionDetails";
import type { AgentTunnelStatus } from "../api/types";
import {
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  ShieldOff,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import type { DataSource } from "../api/client";
import type {
  AgentRegistration,
  AgentSshEnrollment,
  AgentStatusResponse,
  AgentSummary,
  AgentTokenRotation,
} from "../api/types";
import { ErrorNotice } from "../components/ErrorNotice";
import { Loader } from "../components/Loader";
import { Modal } from "../components/Modal";
import { Empty, Kv, Notice, PageTitle, Pill } from "../components/ui";
import { usePolling } from "../hooks/usePolling";
import { backendBaseUrl } from "../lib/backendUrl";
import { fmtTime, relTime } from "../lib/format";
import { useLang, type DictKey } from "../lib/i18n";

const POLL_MS = 10_000;

interface AgentRow {
  agent: AgentSummary;
  status: AgentStatusResponse | null;
  statusError: unknown;
  tunnel: AgentTunnelStatus | null;
}

interface SecretResult {
  title: string;
  body: string;
}

export function AgentList({ source }: { source: DataSource }) {
  const { t, lang } = useLang();
  const poll = usePolling<AgentRow[]>(
    async () => {
      const agents = await source.listAgents();
      return Promise.all(
        agents.map(async (agent) => {
          try {
            const [status, tunnel] = await Promise.all([
              source.getAgentStatus(agent.id),
              source.getAgentTunnel(agent.id).catch(() => null),
            ]);
            return { agent, status, tunnel, statusError: null };
          } catch (statusError) {
            return { agent, status: null, tunnel: null, statusError };
          }
        }),
      );
    },
    POLL_MS,
    [source],
  );
  const [detail, setDetail] = useState<AgentRow | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [secret, setSecret] = useState<SecretResult | null>(null);

  const run = async <T,>(
    key: string,
    action: () => Promise<T>,
    done: (value: T) => void,
  ) => {
    setBusy(key);
    setActionError(null);
    try {
      done(await action());
      poll.refresh();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 64) return;
    await run(
      "create",
      () => source.createAgent(trimmed),
      (result) => {
        setName("");
        setSecret({
          title: t("agentCreatedTitle"),
          body: registrationEnv(result),
        });
      },
    );
  };

  const rotate = (agent: AgentSummary) => {
    if (!window.confirm(t("agentRotateConfirm", { name: agent.name }))) return;
    void run(
      `rotate:${agent.id}`,
      () => source.rotateAgentToken(agent.id),
      (result) => {
        setSecret({
          title: t("agentTokenRotatedTitle"),
          body: tokenEnv(result),
        });
      },
    );
  };

  const revoke = (agent: AgentSummary) => {
    if (!window.confirm(t("agentRevokeConfirm", { name: agent.name }))) return;
    void run(
      `revoke:${agent.id}`,
      () => source.revokeAgentToken(agent.id),
      () => undefined,
    );
  };

  const enroll = (agent: AgentSummary) => {
    void run(
      `ssh:${agent.id}`,
      () => source.createAgentSshEnrollment(agent.id),
      (result) => {
        setSecret({ title: t("agentSshTokenTitle"), body: sshEnv(result) });
      },
    );
  };

  const online =
    poll.data?.filter((row) => row.status?.status === "online").length ?? 0;

  return (
    <div className="page agents-page">
      <PageTitle
        title={t("agentsTitle")}
        sub={
          poll.data
            ? lang === "ko"
              ? `전체 ${poll.data.length}개 · 실행 중 ${online}개`
              : `全${poll.data.length}件 · 稼働中${online}件`
            : t("agentsSub")
        }
        right={
          <span className="live">
            {t("autoRefresh", { s: POLL_MS / 1000 })}
          </span>
        }
      />

      <section className="card agent-create-card">
        <div>
          <h2 className="card-title">
            <Plus size={16} aria-hidden /> {t("agentRegister")}
          </h2>
          <p className="small muted">{t("agentRegisterHelp")}</p>
        </div>
        <form className="agent-create-form" onSubmit={create}>
          <label className="sr-only" htmlFor="agent-name">
            {t("agentName")}
          </label>
          <input
            id="agent-name"
            className="input"
            value={name}
            maxLength={64}
            placeholder={t("agentNamePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy !== null || !name.trim()}
          >
            {busy === "create" ? t("agentRegistering") : t("agentRegister")}
          </button>
        </form>
      </section>

      {actionError !== null && <ErrorNotice error={actionError} />}
      {poll.error !== null && !poll.data && <ErrorNotice error={poll.error} />}
      {poll.loading && !poll.data && <Loader label={t("loading")} />}
      {poll.data?.length === 0 && (
        <section className="card">
          <Empty>{t("agentsEmpty")}</Empty>
        </section>
      )}
      {poll.data && poll.data.length > 0 && (
        <ul className="agent-admin-list">
          {poll.data.map((row) => (
            <AgentCard
              key={row.agent.id}
              row={row}
              busy={busy}
              onRotate={rotate}
              onRevoke={revoke}
              onEnroll={enroll}
              onDetail={() => setDetail(row)}
            />
          ))}
        </ul>
      )}

      {poll.data && poll.lastUpdated && (
        <p className="small muted agent-last-check">
          {t("lastChecked", {
            when: relTime(new Date(poll.lastUpdated).toISOString(), lang),
          })}
        </p>
      )}

      {detail && (
        <AgentConnectionDetails
          agent={detail.agent}
          status={
            poll.data?.find((r) => r.agent.id === detail.agent.id)?.status ??
            detail.status
          }
          source={source}
          onClose={() => setDetail(null)}
        />
      )}
      {secret && (
        <SecretModal result={secret} onClose={() => setSecret(null)} />
      )}
    </div>
  );
}

function AgentCard({
  row,
  busy,
  onRotate,
  onRevoke,
  onEnroll,
  onDetail,
}: {
  row: AgentRow;
  busy: string | null;
  onRotate: (agent: AgentSummary) => void;
  onRevoke: (agent: AgentSummary) => void;
  onEnroll: (agent: AgentSummary) => void;
  onDetail: () => void;
}) {
  const { t, lang } = useLang();
  const { agent, status } = row;
  const current = status?.status ?? agent.status;
  const tone =
    current === "online"
      ? "success"
      : current === "offline" || current === "revoked"
        ? "danger"
        : "muted";
  const working = busy?.endsWith(agent.id) ?? false;
  return (
    <li className="card agent-admin-card">
      <div className="agent-admin-head">
        <div className="agent-admin-name">
          <span className="agent-server-icon" aria-hidden>
            <Server size={18} />
          </span>
          <div>
            <h2>{agent.name}</h2>
            <span className="mono small muted">{agent.id}</span>
          </div>
        </div>
        <div className="row">
          <Pill tone={tone}>
            {current === "online"
              ? lang === "ko"
                ? "Agent 실행 중"
                : "Agent稼働中"
              : t(agentStatusKey(current))}
          </Pill>
          <Pill
            tone={
              row.tunnel?.connected
                ? "success"
                : row.tunnel?.state === "idle"
                  ? "muted"
                  : "warning"
            }
          >
            SSH · {tunnelLabel(row.tunnel?.state, lang)}
          </Pill>
        </div>
      </div>

      {row.statusError !== null && (
        <Notice tone="warning">{t("agentStatusUnavailable")}</Notice>
      )}
      <Kv
        columns={3}
        items={[
          [
            t("agentLastHeartbeat"),
            status?.last_seen_at
              ? `${relTime(status.last_seen_at, lang)} · ${fmtTime(status.last_seen_at)}`
              : t("none"),
          ],
          [
            lang === "ko" ? "SSH 연결" : "SSH接続",
            tunnelLabel(row.tunnel?.state, lang),
          ],
          [
            lang === "ko" ? "포워딩" : "転送",
            row.tunnel
              ? `${row.tunnel.active_forwards} / ${row.tunnel.requested_forwards}`
              : "—",
          ],
          [
            t("agentPublicUrl"),
            status?.public_url ? (
              <a href={status.public_url} target="_blank" rel="noreferrer">
                {status.public_url}
              </a>
            ) : (
              t("none")
            ),
          ],
        ]}
      />

      {status?.serving && (
        <div className="agent-serving">
          <span className="small muted">{t("agentServing")}</span>
          <strong>{status.serving.container}</strong>
          <span className="mono small">{status.serving.digest}</span>
        </div>
      )}

      <div className="agent-actions">
        <button className="btn btn-small" onClick={onDetail}>
          {lang === "ko" ? "연결 상세" : "接続詳細"}
        </button>
        <button
          className="btn btn-small"
          type="button"
          disabled={working || current === "revoked"}
          onClick={() => onEnroll(agent)}
        >
          <TerminalSquare size={14} aria-hidden /> {t("agentIssueSsh")}
        </button>
        <button
          className="btn btn-small"
          type="button"
          disabled={working || current === "revoked"}
          onClick={() => onRotate(agent)}
        >
          <RefreshCw size={14} aria-hidden /> {t("agentRotateToken")}
        </button>
        <button
          className="btn btn-small btn-danger"
          type="button"
          disabled={working || current === "revoked"}
          onClick={() => onRevoke(agent)}
        >
          <ShieldOff size={14} aria-hidden /> {t("agentRevokeToken")}
        </button>
      </div>
    </li>
  );
}

function SecretModal({
  result,
  onClose,
}: {
  result: SecretResult;
  onClose: () => void;
}) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(result.body);
    setCopied(true);
  };
  return (
    <Modal title={result.title} onClose={onClose}>
      <div className="stack">
        <Notice tone="warning" title={t("agentSecretOnce")}>
          {t("agentSecretOnceHelp")}
        </Notice>
        <pre className="code agent-secret">{result.body}</pre>
        <div className="row">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void copy()}
          >
            <KeyRound size={14} aria-hidden />{" "}
            {copied ? t("agentCopied") : t("agentCopyEnv")}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function registrationEnv(result: AgentRegistration): string {
  return [
    `BACKEND_API_URL=${backendBaseUrl()}`,
    `AGENT_ID=${result.agent.id}`,
    `AGENT_TOKEN=${result.token}`,
    `SSH_ENROLLMENT_TOKEN=${result.ssh_enrollment_token}`,
    ...sshLines(result.ssh),
    `# SSH_ENROLLMENT_TOKEN expires at ${result.expires_at}`,
  ].join("\n");
}

function tokenEnv(result: AgentTokenRotation): string {
  return [`AGENT_ID=${result.agent.id}`, `AGENT_TOKEN=${result.token}`].join(
    "\n",
  );
}

function sshEnv(result: AgentSshEnrollment): string {
  return [
    `AGENT_ID=${result.agent_id}`,
    `SSH_ENROLLMENT_TOKEN=${result.ssh_enrollment_token}`,
    ...sshLines(result.ssh),
    `# SSH_ENROLLMENT_TOKEN expires at ${result.expires_at}`,
  ].join("\n");
}

function sshLines(ssh: AgentSshEnrollment["ssh"]): string[] {
  return [
    `SSH_HOST=${ssh.host}`,
    `SSH_PORT=${ssh.port}`,
    `SSH_USER=${ssh.user}`,
    `SSH_HOST_KEY_SHA256=${ssh.host_key_sha256}`,
  ];
}

function agentStatusKey(status: AgentSummary["status"]): DictKey {
  const keys: Record<AgentSummary["status"], DictKey> = {
    registered: "agentStatus_registered",
    online: "agentStatus_online",
    offline: "agentStatus_offline",
    revoked: "agentStatus_revoked",
  };
  return keys[status];
}
