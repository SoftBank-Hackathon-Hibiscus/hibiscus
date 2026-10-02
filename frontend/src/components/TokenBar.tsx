import { useState } from 'react';
import { readToken, writeToken } from '../api/token';
import { useLang } from '../lib/i18n';

/** access token 붙여넣기. localStorage 에 저장하고 Authorization 헤더로 쓴다. refresh 는 하지 않는다. */
export function TokenBar({ onChange }: { onChange: () => void }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(() => !readToken());
  const [draft, setDraft] = useState('');
  const current = readToken();

  const save = () => {
    const token = draft.trim();
    if (!token) return;
    writeToken(token);
    setDraft('');
    setEditing(false);
    onChange();
  };
  const clear = () => {
    writeToken(null);
    setEditing(true);
    onChange();
  };

  if (!editing && current) {
    return (
      <div className="tokenbar">
        <span className="tokenbar-state">
          {t('tokenSaved')} <span className="mono">{current.slice(0, 8)}…</span>
        </span>
        <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>{t('change')}</button>
        <button type="button" className="btn btn-small" onClick={clear}>{t('clear')}</button>
      </div>
    );
  }
  return (
    <form
      className="tokenbar"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input className="input mono" type="password" placeholder={t('tokenPlaceholder')} value={draft} onChange={(event) => setDraft(event.target.value)} autoComplete="off" spellCheck={false} />
      <button type="submit" className="btn btn-small btn-primary" disabled={!draft.trim()}>{t('save')}</button>
      {current && <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>{t('cancel')}</button>}
    </form>
  );
}
