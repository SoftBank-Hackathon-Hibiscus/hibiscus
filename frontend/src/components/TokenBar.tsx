import { useState } from 'react';
import { parsePastedToken, readRefreshToken, readToken, writeToken, writeTokens } from '../api/token';
import { useLang } from '../lib/i18n';

/**
 * access token 붙여넣기. `abc`, `Bearer abc`, 콜백 JSON 전체 모두 받는다.
 * JSON 전체면 refresh token 도 함께 저장한다. 토큰을 지우면 refresh 도 같이 지워진다.
 */
export function TokenBar({ onChange }: { onChange: () => void }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(() => !readToken());
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = readToken();
  const hasRefresh = Boolean(readRefreshToken());

  const save = () => {
    const parsed = parsePastedToken(draft);
    if (!parsed.ok) {
      setError(parsed.reason === 'invalid_json' ? t('tokenInvalidJson') : parsed.reason === 'no_access_token' ? t('tokenNoAccess') : t('tokenEmpty'));
      return;
    }
    writeTokens({ accessToken: parsed.accessToken, refreshToken: parsed.refreshToken });
    setDraft('');
    setError(null);
    setEditing(false);
    onChange();
  };
  const clear = () => {
    writeToken(null);
    setEditing(true);
    setError(null);
    onChange();
  };

  if (!editing && current) {
    return (
      <div className="tokenbar">
        <span className="tokenbar-state">
          {t('tokenSaved')} <span className="mono">{current.slice(0, 8)}…</span>
          {hasRefresh && <span className="muted"> ({t('withRefresh')})</span>}
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
      <input
        className="input mono"
        type="password"
        placeholder={t('tokenPlaceholder')}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
      />
      <button type="submit" className="btn btn-small btn-primary" disabled={!draft.trim()}>{t('save')}</button>
      {current && <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>{t('cancel')}</button>}
      {error && <span className="small tone-danger tokenbar-error" role="alert">{error}</span>}
    </form>
  );
}
