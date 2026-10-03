import { useMemo, useState, type ReactNode } from "react";
import { usePolling } from "../hooks/usePolling";
import { ErrorNotice } from "./ErrorNotice";
import { ApiError, type DataSource } from "../api/client";
import { describeError } from "./ErrorNotice";
import { Modal } from "./Modal";
import { Collapsible, Notice } from "./ui";
import {
  friendlyBackendError,
  toCreateDeploymentInput,
  validateDeployment,
  type DeploymentDraft,
} from "../lib/forms";
import { useLang } from "../lib/i18n";
import { deploymentPath, navigate } from "../lib/router";

/**
 * 새 배포 (POST /applications/:id/deployments, CreateDeploymentDto).
 * GitHub 저장소 앱(requireFullSha)은 40자리 전체 SHA 만 받는다 (lib/forms FULL_SHA_RE 주석).
 * real 에서는 실제 파이프라인이 돌기 때문에 경고를 먼저 보여 준다. mock 은 대기 중(queued) 배포만 만들고 자동으로 진행하지 않는다.
 */
export function NewDeploymentModal({
  source,
  applicationId,
  requireFullSha,
  onClose,
}: {
  source: DataSource;
  applicationId: string;
  requireFullSha: boolean;
  onClose: () => void;
}) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState<DeploymentDraft>({
    sourceRevision: "",
    imageDigest: "",
  });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [commitPage, setCommitPage] = useState(1);
  const commits = usePolling(
    () =>
      requireFullSha
        ? source.listApplicationCommits(applicationId, commitPage)
        : Promise.resolve(null),
    null,
    [source, applicationId, commitPage, requireFullSha],
  );
  const selected = commits.data?.commits.find(
    (c) => c.sha === draft.sourceRevision,
  );
  const copy = (ko: string, ja: string) => (lang === "ko" ? ko : ja);
  const errors = useMemo(
    () => validateDeployment(draft, { requireFullSha }),
    [draft, requireFullSha],
  );
  const show = (field: keyof DeploymentDraft) =>
    touched && errors[field] ? t(errors[field]!) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await source.createDeployment(
        applicationId,
        toCreateDeploymentInput(draft),
      );
      onClose();
      navigate(deploymentPath(created.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const friendly =
    error instanceof ApiError ? friendlyBackendError(error.message) : null;
  const described = error === null ? null : describeError(error, lang);

  return (
    <Modal title={t("newDeployment")} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {requireFullSha && (
          <div className="stack-sm">
            <div className="card-head">
              <label className="field-label" htmlFor="deployCommit">
                {copy("커밋 선택", "コミット選択")} · {commits.data?.branch}
              </label>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || commits.loading}
                onClick={commits.refresh}
              >
                {copy("새로고침", "更新")}
              </button>
            </div>
            <ErrorNotice error={commits.error} />
            <select
              id="deployCommit"
              className="input"
              value={selected?.sha ?? ""}
              disabled={busy || commits.loading}
              onChange={(e) =>
                setDraft((d) => ({ ...d, sourceRevision: e.target.value }))
              }
            >
              <option value="">
                {copy(
                  commits.loading ? "커밋 조회 중…" : "커밋 선택",
                  commits.loading ? "取得中…" : "コミット選択",
                )}
              </option>
              {!commits.loading &&
                commits.data?.commits.map((c) => (
                  <option key={c.sha} value={c.sha}>
                    {c.sha.slice(0, 12)} · {c.message.split("\n")[0]}
                  </option>
                ))}
            </select>
            {selected && (
              <pre
                className="small"
                style={{ whiteSpace: "pre-wrap", margin: 0 }}
              >
                {selected.message}
              </pre>
            )}
            <div className="row">
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || commits.loading || commitPage === 1}
                onClick={() => setCommitPage((p) => p - 1)}
              >
                {copy("이전", "前へ")}
              </button>
              <span>{commitPage}</span>
              <button
                type="button"
                className="btn btn-small"
                disabled={
                  busy ||
                  commits.loading ||
                  !!commits.error ||
                  !commits.data?.hasMore
                }
                onClick={() => setCommitPage((p) => p + 1)}
              >
                {copy("다음", "次へ")}
              </button>
            </div>
          </div>
        )}
        <Field
          label={t("sourceRevisionLabel")}
          htmlFor="sourceRevision"
          hint={t(
            requireFullSha ? "sourceRevisionHintFull" : "sourceRevisionHint",
          )}
          error={show("sourceRevision")}
        >
          <input
            id="sourceRevision"
            className="input mono"
            value={draft.sourceRevision}
            spellCheck={false}
            autoFocus
            placeholder="1f6947dce692de48ef4580b1a3f5366adf66f5ae"
            onChange={(e) =>
              setDraft((d) => ({ ...d, sourceRevision: e.target.value }))
            }
          />
        </Field>
        <div className="fold-list">
          <Collapsible
            title={t("advancedSettings")}
            defaultOpen={Boolean(draft.imageDigest)}
          >
            <Field
              label={t("imageDigestLabel")}
              htmlFor="imageDigest"
              hint={t("imageDigestHint")}
              error={show("imageDigest")}
            >
              <input
                id="imageDigest"
                className="input mono"
                value={draft.imageDigest}
                spellCheck={false}
                placeholder="sha256:…"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, imageDigest: e.target.value }))
                }
              />
            </Field>
          </Collapsible>
        </div>
        {described && (
          <Notice
            tone={described.unauthorized ? "warning" : "danger"}
            title={t("deploymentFailed")}
          >
            {friendly ? t(friendly) : described.title}
            {described.detail && !friendly && (
              <span className="mono small"> ({described.detail})</span>
            )}
          </Notice>
        )}
        <div className="row form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t("starting") : t("startDeployment")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            {t("cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="form-error">{error}</span>
      ) : hint ? (
        <span className="form-hint">{hint}</span>
      ) : null}
    </div>
  );
}
