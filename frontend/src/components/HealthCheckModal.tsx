import { useMemo, useState, type ReactNode } from 'react';
import type { DataSource } from '../api/client';
import type { HealthCheckConfig } from '../api/types';
import { describeError } from './ErrorNotice';
import { Modal } from './Modal';
import { Notice } from './ui';
import { healthCheckDraft, toHealthCheckInput, validateHealthCheck, type HealthCheckDraft, type HealthCheckError, type HealthCheckField } from '../lib/healthCheck';
import { useLang, type DictKey } from '../lib/i18n';

const ERROR_KEY: Record<HealthCheckError, DictKey> = {
  required: 'healthRequiredError',
  path: 'healthPathError',
  interval: 'healthIntervalError',
  timeout: 'healthTimeoutError',
  status: 'healthStatusError',
  threshold: 'healthThresholdError',
  timeoutOrder: 'healthTimeoutOrderError',
  statusOrder: 'healthStatusOrderError',
};

export function HealthCheckModal({ source, applicationId, config, onClose, onSaved }: { source: DataSource; applicationId: string; config: HealthCheckConfig; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState<HealthCheckDraft>(() => healthCheckDraft(config));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = useMemo(() => validateHealthCheck(draft), [draft]);
  const fieldError = (field: HealthCheckField) => (touched && errors[field] ? t(ERROR_KEY[errors[field]!]) : null);
  const described = error === null ? null : describeError(error, lang);
  const update = <K extends keyof HealthCheckDraft>(field: K, value: HealthCheckDraft[K]) => setDraft((current) => ({ ...current, [field]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await source.updateHealthCheck(applicationId, toHealthCheckInput(draft));
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('healthSettings')} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <label className="check-row">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} />
          {t('healthEnabled')}
        </label>

        <div className="form-grid">
          <Field label={t('healthPath')} htmlFor="health-path" error={fieldError('path')} wide>
            <input id="health-path" className="input mono" value={draft.path} maxLength={256} placeholder="/health" onChange={(event) => update('path', event.target.value)} />
          </Field>
          <Field label={t('healthVersionPath')} htmlFor="health-version-path" hint={t('healthOptional')} error={fieldError('versionPath')} wide>
            <input id="health-version-path" className="input mono" value={draft.versionPath} maxLength={256} placeholder="/version" onChange={(event) => update('versionPath', event.target.value)} />
          </Field>
          <Field label={t('healthMethod')} htmlFor="health-method">
            <select id="health-method" className="input" value={draft.method} onChange={(event) => update('method', event.target.value as HealthCheckDraft['method'])}>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
          </Field>
          <Field label={t('healthInterval')} htmlFor="health-interval" error={fieldError('intervalSeconds')}>
            <input id="health-interval" className="input" type="number" inputMode="numeric" min={1} max={300} value={draft.intervalSeconds} onChange={(event) => update('intervalSeconds', event.target.value)} />
          </Field>
          <Field label={t('healthTimeout')} htmlFor="health-timeout" error={fieldError('timeoutSeconds')}>
            <input id="health-timeout" className="input" type="number" inputMode="numeric" min={1} max={60} value={draft.timeoutSeconds} onChange={(event) => update('timeoutSeconds', event.target.value)} />
          </Field>
          <Field label={t('healthSuccessThreshold')} htmlFor="health-success-threshold" error={fieldError('successThreshold')}>
            <input id="health-success-threshold" className="input" type="number" inputMode="numeric" min={1} max={20} value={draft.successThreshold} onChange={(event) => update('successThreshold', event.target.value)} />
          </Field>
          <Field label={t('healthFailureThreshold')} htmlFor="health-failure-threshold" error={fieldError('failureThreshold')}>
            <input id="health-failure-threshold" className="input" type="number" inputMode="numeric" min={1} max={20} value={draft.failureThreshold} onChange={(event) => update('failureThreshold', event.target.value)} />
          </Field>
          <Field label={t('healthStatusMin')} htmlFor="health-status-min" error={fieldError('successStatusMin')}>
            <input id="health-status-min" className="input" type="number" inputMode="numeric" min={100} max={599} value={draft.successStatusMin} onChange={(event) => update('successStatusMin', event.target.value)} />
          </Field>
          <Field label={t('healthStatusMax')} htmlFor="health-status-max" error={fieldError('successStatusMax')}>
            <input id="health-status-max" className="input" type="number" inputMode="numeric" min={100} max={599} value={draft.successStatusMax} onChange={(event) => update('successStatusMax', event.target.value)} />
          </Field>
        </div>

        {described && <Notice tone={described.unauthorized ? 'warning' : 'danger'} title={t('healthSaveFailed')}>{described.title}{described.detail && <span className="mono small"> ({described.detail})</span>}</Notice>}
        <div className="row form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('saving') : t('save')}</button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, htmlFor, hint, error, wide = false, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`form-field${wide ? ' form-field-wide' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="form-error">{error}</span> : hint ? <span className="form-hint">{hint}</span> : null}
    </div>
  );
}
