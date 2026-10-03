import { Plus, Trash2 } from 'lucide-react';
import type { ApplicationEnvironmentVariableInput } from '../api/types';
import { ENV_MAX_COUNT, validateEnvironment } from '../lib/forms';
import { useLang } from '../lib/i18n';

export function EnvironmentEditor({ value, onChange, disabled = false }: { value: ApplicationEnvironmentVariableInput[]; onChange: (value: ApplicationEnvironmentVariableInput[]) => void; disabled?: boolean }) {
  const { t } = useLang();
  const issue = validateEnvironment(value);
  const update = (index: number, patch: Partial<ApplicationEnvironmentVariableInput>) => onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="environment-editor">
      {value.length === 0 ? <p className="small muted">{t('environmentEmpty')}</p> : null}
      {value.map((row, index) => (
        <div className="environment-row" key={index}>
          <input aria-label={t('environmentName')} className="input mono" placeholder="DATABASE_URL" value={row.name} maxLength={64} spellCheck={false} disabled={disabled} onChange={(event) => update(index, { name: event.target.value.toUpperCase() })} />
          <input aria-label={t('environmentValue')} className="input mono" type="password" autoComplete="new-password" placeholder={t('environmentValuePlaceholder')} value={row.value} maxLength={4096} disabled={disabled} onChange={(event) => update(index, { value: event.target.value })} />
          <button type="button" className="icon-btn" aria-label={t('environmentRemove')} disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>
            <Trash2 size={15} aria-hidden />
          </button>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn btn-small" disabled={disabled || value.length >= ENV_MAX_COUNT} onClick={() => onChange([...value, { name: '', value: '' }])}>
          <Plus size={14} aria-hidden /> {t('environmentAdd')}
        </button>
        <span className="small muted">{t('environmentCount', { count: value.length, max: ENV_MAX_COUNT })}</span>
      </div>
      {issue ? <p className="form-error">{t(issue === 'count' ? 'environmentErrorCount' : issue === 'name' ? 'environmentErrorName' : issue === 'duplicate' ? 'environmentErrorDuplicate' : issue === 'reserved' ? 'environmentErrorReserved' : 'environmentErrorValue')}</p> : null}
    </div>
  );
}
