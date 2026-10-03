import { useMemo, useState, type ReactNode } from 'react';
import { ApiError, type DataSource } from '../api/client';
import { describeError } from './ErrorNotice';
import { Modal } from './Modal';
import { Collapsible, Notice } from './ui';
import { friendlyBackendError, toCreateDeploymentInput, validateDeployment, type DeploymentDraft } from '../lib/forms';
import { useLang } from '../lib/i18n';
import { deploymentPath, navigate } from '../lib/router';

/**
 * 새 배포 (POST /applications/:id/deployments, CreateDeploymentDto).
 * real 에서는 실제 파이프라인이 돌기 때문에 경고를 먼저 보여 준다. mock 은 대기 중(queued) 배포만 만들고 자동으로 진행하지 않는다.
 */
export function NewDeploymentModal({ source, applicationId, onClose }: { source: DataSource; applicationId: string; onClose: () => void }) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState<DeploymentDraft>({ sourceRevision: '', imageDigest: '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = useMemo(() => validateDeployment(draft), [draft]);
  const show = (field: keyof DeploymentDraft) => (touched && errors[field] ? t(errors[field]!) : null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await source.createDeployment(applicationId, toCreateDeploymentInput(draft));
      onClose();
      navigate(deploymentPath(created.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const friendly = error instanceof ApiError ? friendlyBackendError(error.message) : null;
  const described = error === null ? null : describeError(error, lang);

  return (
    <Modal title={t('newDeployment')} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <p className="small muted">{t('newDeploymentSub')}</p>
        <Notice tone={source.kind === 'real' ? 'warning' : 'muted'}>{source.kind === 'real' ? t('deployRealWarning') : t('deployMockNote')}</Notice>
        <Field label={t('sourceRevisionLabel')} htmlFor="sourceRevision" hint={t('sourceRevisionHint')} error={show('sourceRevision')}>
          <input id="sourceRevision" className="input mono" value={draft.sourceRevision} spellCheck={false} autoFocus placeholder="1f6947dce692de48ef4580b1a3f5366adf66f5ae" onChange={(e) => setDraft((d) => ({ ...d, sourceRevision: e.target.value }))} />
        </Field>
        <div className="fold-list">
          <Collapsible title={t('advancedSettings')} defaultOpen={Boolean(draft.imageDigest)}>
            <Field label={t('imageDigestLabel')} htmlFor="imageDigest" hint={t('imageDigestHint')} error={show('imageDigest')}>
              <input id="imageDigest" className="input mono" value={draft.imageDigest} spellCheck={false} placeholder="sha256:…" onChange={(e) => setDraft((d) => ({ ...d, imageDigest: e.target.value }))} />
            </Field>
          </Collapsible>
        </div>
        {described && (
          <Notice tone={described.unauthorized ? 'warning' : 'danger'} title={t('deploymentFailed')}>
            {friendly ? t(friendly) : described.title}
            {described.detail && !friendly && <span className="mono small"> ({described.detail})</span>}
          </Notice>
        )}
        <div className="row form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t('starting') : t('startDeployment')}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="form-field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <span className="form-error">{error}</span> : hint ? <span className="form-hint">{hint}</span> : null}
    </div>
  );
}
