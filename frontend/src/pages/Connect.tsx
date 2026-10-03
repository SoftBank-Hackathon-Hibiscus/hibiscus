import { Check, ExternalLink, Minus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Collapsible, PageTitle } from '../components/ui';
import type { ConnectionState } from '../hooks/useConnection';
import { backendBaseUrl, isLocalBackend, oauthStartUrl } from '../lib/backendUrl';
import type { Tone } from '../lib/deployState';
import { useLang } from '../lib/i18n';
import { APPLICATIONS_PATH, REGISTER_PATH, applicationPath, deploymentPath, navigate, realHref } from '../lib/router';

type StepState = 'idle' | 'checking' | 'ok' | 'warn' | 'fail';

/**
 * 실제 환경 연결. ① 서버 연결 → ② GitHub 인증 → ③ 시작.
 * Backend에서 로그인하고, Callback이 토큰 Fragment와 함께 이 화면으로 돌아온다.
 * main.tsx가 React 실행 전에 토큰을 저장하고 민감한 Fragment를 제거한다.
 * 실패해도 mock 으로 돌아가지 않는다.
 */
export function Connect({ connection, onRecheck }: { connection: ConnectionState; onRecheck: () => void }) {
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

        <StepCard n={2} state={authState} title={t('stepGithubAuth')} status={!serverOk ? t('serverFirst') : signedIn ? `@${connection.user.login}` : connection.level === 'login' && connection.tokenPresent ? t('tokenInvalid') : t('loginNeeded')}>
          {serverOk && !signedIn && <SignIn connection={connection} base={base} />}
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

const STATE_TONE: Record<StepState, Tone> = {
  idle: 'muted',
  checking: 'muted',
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
};

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

/** Backend에서 GitHub 로그인을 시작한다. 성공하면 Callback이 이 화면으로 자동 복귀한다. */
function SignIn({ connection, base }: { connection: ConnectionState; base: string }) {
  const { t } = useLang();
  const startUrl = oauthStartUrl(base);

  return (
    <div className="step-body">
      {connection.level === 'login' && connection.tokenPresent && <p className="step-help tone-warning">{t('savedTokenInvalid')}</p>}
      <a className="btn btn-primary" href={startUrl}>
        {t('startGithubLogin')} <ExternalLink size={14} aria-hidden />
      </a>
      <p className="step-help">{t('signinHelp1')}</p>
    </div>
  );
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
