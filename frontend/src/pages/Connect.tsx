import { Check, ExternalLink, Minus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError, type DataSource } from '../api/client';
import { parsePastedToken, writeToken, writeTokens } from '../api/token';
import { Collapsible, PageTitle } from '../components/ui';
import type { ConnectionState } from '../hooks/useConnection';
import { backendBaseUrl, isLocalBackend, oauthStartUrl } from '../lib/backendUrl';
import type { Tone } from '../lib/deployState';
import { useLang } from '../lib/i18n';
import { APPLICATIONS_PATH, REGISTER_PATH, applicationPath, deploymentPath, navigate, realHref } from '../lib/router';
import { finishSignIn } from '../lib/session';

type StepState = 'idle' | 'checking' | 'ok' | 'warn' | 'fail';

/**
 * 실제 환경 연결. ① 서버 연결 → ② GitHub 인증 → ③ 시작.
 * backend 계약은 그대로다: GET /auth/github 는 { authorization_url } JSON 을 돌려주고, state 쿠키는 backend 호스트에 붙는다.
 * 그래서 로그인 시작은 backend 주소를 새 탭으로 직접 열고, 콜백 JSON 을 붙여넣어 토큰을 저장한다.
 * 실패해도 mock 으로 돌아가지 않는다.
 */
export function Connect({ source, connection, onTokenChange, onRecheck }: { source: DataSource; connection: ConnectionState; onTokenChange: () => void; onRecheck: () => void }) {
  const { t } = useLang();
  const base = backendBaseUrl();
  const local = isLocalBackend(base);
  const serverOk = connection.level === 'login' || connection.level === 'ok';
  const signedIn = connection.level === 'ok';

  const serverState: StepState = connection.level === 'checking' ? 'checking' : serverOk ? 'ok' : 'fail';
  const authState: StepState = !serverOk ? 'idle' : signedIn ? 'ok' : connection.level === 'login' && connection.tokenPresent ? 'warn' : 'idle';
  const startState: StepState = signedIn ? 'ok' : 'idle';

  return (
    <div className="page page-narrow connect">
      <PageTitle title={t('connectTitle')} sub={t('connectSub')} />

      <ol className="steps">
        <StepCard n={1} state={serverState} title={t('stepServer')} status={connection.level === 'checking' ? t('connChecking') : serverOk ? t('serverResponds') : t('serverDown')}>
          <p className="step-note">
            {t('serverAddress')} <code>{base}</code>
            {local ? ` · ${t('serverLocalNote')}` : ` · ${t('serverRemoteNote')}`}
          </p>
          {connection.level === 'down' && (
            <div className="step-body">
              <p className="step-help">{local ? t('serverDownHelpLocal') : t('serverDownHelpRemote')}</p>
              <p className="small muted mono">{connection.detail}</p>
              <div>
                <button type="button" className="btn btn-small" onClick={onRecheck}>
                  {t('recheck')}
                </button>
              </div>
            </div>
          )}
        </StepCard>

        <StepCard
          n={2}
          state={authState}
          title={t('stepGithubAuth')}
          status={!serverOk ? t('serverFirst') : signedIn ? `@${connection.user.login}` : connection.level === 'login' && connection.tokenPresent ? t('tokenInvalid') : t('loginNeeded')}
        >
          {serverOk && !signedIn && <SignIn source={source} connection={connection} base={base} onTokenChange={onTokenChange} />}
          {signedIn && <p className="step-help">{t('signedInNote')}</p>}
        </StepCard>

        <StepCard n={3} state={startState} title={t('stepStart')} status={signedIn ? t('ready') : t('authFirst')}>
          {signedIn && (
            <div className="row">
              <a className="btn btn-primary" href={realHref(APPLICATIONS_PATH)}>
                {t('homeCtaApps')}
              </a>
              <a className="btn" href={realHref(REGISTER_PATH)}>
                {t('registerApp')}
              </a>
            </div>
          )}
        </StepCard>
      </ol>

      <section className="card card-collapsed">
        <Collapsible title={t('advanced')}>
          <GoTo />
        </Collapsible>
      </section>
    </div>
  );
}

const STATE_TONE: Record<StepState, Tone> = { idle: 'muted', checking: 'muted', ok: 'success', warn: 'warning', fail: 'danger' };

function StepCard({ n, state, title, status, children }: { n: number; state: StepState; title: string; status: string; children?: ReactNode }) {
  const tone = STATE_TONE[state];
  const Icon = state === 'ok' ? Check : state === 'fail' ? X : state === 'warn' ? Minus : null;
  return (
    <li className={`card step-card step-card-${state}`}>
      <div className="step-card-head">
        <span className={`step-card-mark tone-${tone}`} aria-hidden>
          {Icon ? <Icon size={14} /> : <span className="num">{n}</span>}
        </span>
        <h2 className="step-card-title">{title}</h2>
        <span className={`step-card-status tone-${tone}`}>{status}</span>
      </div>
      {children}
    </li>
  );
}

/** GitHub 로그인 시작 + 콜백 JSON 붙여넣기. 저장 즉시 /users/me 로 확인하고, 되면 앱 목록으로 간다. */
function SignIn({ source, connection, base, onTokenChange }: { source: DataSource; connection: ConnectionState; base: string; onTokenChange: () => void }) {
  const { t } = useLang();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startUrl = oauthStartUrl(base);

  const submit = async () => {
    const parsed = parsePastedToken(draft);
    if (!parsed.ok) {
      setError(parsed.reason === 'invalid_json' ? t('tokenInvalidJson') : parsed.reason === 'no_access_token' ? t('tokenNoAccess') : t('tokenEmpty'));
      return;
    }
    setBusy(true);
    setError(null);
    writeTokens({ accessToken: parsed.accessToken, refreshToken: parsed.refreshToken });
    try {
      await source.me();
      setDraft('');
      onTokenChange();
      finishSignIn();
    } catch (e) {
      // 확인에 실패한 토큰은 두지 않는다. 상단 상태도 "로그인 필요"로 돌아간다.
      writeToken(null);
      onTokenChange();
      setError(describeAuthError(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="step-body">
      {connection.level === 'login' && connection.tokenPresent && <p className="step-help tone-warning">{t('savedTokenInvalid')}</p>}
      <ol className="signin-steps">
        <li>
          <a className="btn btn-primary" href={startUrl} target="_blank" rel="noopener noreferrer">
            {t('startGithubLogin')} <ExternalLink size={14} aria-hidden />
          </a>
          <span className="step-help">{t('signinHelp1')}</span>
        </li>
        <li>
          <span className="step-help">{t('signinHelp2')}</span>
        </li>
        <li>
          <form
            className="signin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="field-label" htmlFor="callback-json">
              {t('pasteLabel')}
            </label>
            <textarea
              id="callback-json"
              className="input signin-input"
              rows={3}
              placeholder='{"access_token": "...", "refresh_token": "..."}'
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'callback-error' : undefined}
            />
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
                {busy ? t('verifying') : t('saveAndVerify')}
              </button>
              <span className="small muted">{t('pasteNote')}</span>
            </div>
            {error && (
              <p id="callback-error" className="small tone-danger" role="alert">
                {error}
              </p>
            )}
          </form>
        </li>
      </ol>
    </div>
  );
}

function describeAuthError(error: unknown, t: ReturnType<typeof useLang>['t']): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return t('authForbidden');
    if (error.status === 401) return t('authExpired');
    if (error.status === 0) return t('backendUnreachable');
    return `${t('requestFailed')} (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function GoTo() {
  const { t } = useLang();
  const [kind, setKind] = useState<'application' | 'deployment'>('application');
  const [value, setValue] = useState('');
  return (
    <form
      className="goto"
      onSubmit={(event) => {
        event.preventDefault();
        const id = value.trim();
        if (!id) return;
        navigate(kind === 'application' ? applicationPath(id) : deploymentPath(id));
      }}
    >
      <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'application' | 'deployment')} aria-label={t('gotoKind')}>
        <option value="application">application id</option>
        <option value="deployment">deployment id</option>
      </select>
      <input className="input mono" placeholder="id" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} aria-label="id" />
      <button type="submit" className="btn btn-small">
        {t('goto')}
      </button>
    </form>
  );
}
