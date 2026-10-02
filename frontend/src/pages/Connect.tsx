import { useEffect, useState } from 'react';
import type { DataSource } from '../api/client';
import type { ApplicationView } from '../api/types';
import { TokenBar } from '../components/TokenBar';
import { ErrorNotice } from '../components/ErrorNotice';
import { Collapsible, Empty, PageTitle } from '../components/ui';
import type { ConnectionState } from '../hooks/useConnection';
import { useLang } from '../lib/i18n';
import { applicationPath, deploymentPath, hrefFor, navigate } from '../lib/router';

/** real 모드 홈. 백엔드 → 토큰 → 앱 선택 순서의 체크리스트. 실패해도 mock 으로 돌아가지 않는다. */
export function Connect({ source, connection, onTokenChange, onRecheck }: { source: DataSource; connection: ConnectionState; onTokenChange: () => void; onRecheck: () => void }) {
  const { t, lang } = useLang();
  const backendOk = connection.level === 'login' || connection.level === 'ok';
  const tokenOk = connection.level === 'ok';

  const [apps, setApps] = useState<ApplicationView[] | null>(null);
  const [appsError, setAppsError] = useState<unknown>(null);
  useEffect(() => {
    if (!tokenOk) {
      setApps(null);
      return;
    }
    let cancelled = false;
    source
      .listApplications()
      .then((list) => !cancelled && setApps(list))
      .catch((error: unknown) => !cancelled && setAppsError(error));
    return () => {
      cancelled = true;
    };
  }, [source, tokenOk]);

  return (
    <div className="page connect">
      <PageTitle title={t('connectTitle')} sub={t('connectSub')} />

      <ol className="checklist">
        <li className={`card check-item ${connection.level === 'checking' ? '' : backendOk ? 'check-ok' : 'check-fail'}`}>
          <div className="check-head">
            <span className="check-mark" aria-hidden>{connection.level === 'checking' ? '…' : backendOk ? '✓' : '✕'}</span>
            <strong>{t('backend')}</strong>
            <span className="check-state">
              {connection.level === 'checking' && t('connChecking')}
              {connection.level === 'down' && t('notConnected')}
              {backendOk && t('responds')}
            </span>
            <button type="button" className="btn btn-small" onClick={onRecheck}>{t('recheck')}</button>
          </div>
          {connection.level === 'down' && (
            <p className="check-help">
              {lang === 'ja'
                ? 'GET /healthz が応答しません。backend-v2 を起動し、アドレスが違う場合は '
                : 'GET /healthz 가 응답하지 않습니다. backend-v2를 실행하고, 주소가 다르면 '}
              <code>frontend/.env.local</code> <code>VITE_BACKEND_URL</code>
              {lang === 'ja' ? ' を変更して開発サーバーを再起動してください。' : ' 을 바꾼 뒤 개발 서버를 다시 시작하세요.'} <span className="muted">({connection.detail})</span>
            </p>
          )}
        </li>

        <li className={`card check-item ${!backendOk ? 'check-idle' : tokenOk ? 'check-ok' : 'check-warn'}`}>
          <div className="check-head">
            <span className="check-mark" aria-hidden>{!backendOk ? '–' : tokenOk ? '✓' : '!'}</span>
            <strong>{t('token')}</strong>
            <span className="check-state">
              {!backendOk && t('backendFirst')}
              {backendOk && connection.level === 'login' && (connection.tokenPresent ? t('tokenInvalid') : t('loginNeeded'))}
              {tokenOk && `@${connection.user.login}`}
            </span>
          </div>
          {backendOk && !tokenOk && (
            <div className="check-body">
              <p className="check-help">
                {lang === 'ja' ? (
                  <>
                    ブラウザで <code>/auth/github</code> を開き <code>authorization_url</code> へ移動、GitHub ログイン後のコールバック JSON にある <code>access_token</code> を下に貼り付けてください。既定の期限は15分です。
                  </>
                ) : (
                  <>
                    브라우저로 <code>/auth/github</code> 를 열어 <code>authorization_url</code> 로 이동하고, GitHub 로그인 뒤 콜백 JSON의 <code>access_token</code> 을 아래에 붙여넣으세요. 기본 만료는 15분입니다.
                  </>
                )}
                {connection.level === 'login' && connection.tokenPresent && <span className="muted"> ({connection.detail})</span>}
              </p>
              <TokenBar onChange={onTokenChange} />
            </div>
          )}
          {tokenOk && (
            <div className="check-body">
              <TokenBar onChange={onTokenChange} />
            </div>
          )}
        </li>

        <li className={`card check-item ${tokenOk ? (apps && apps.length ? 'check-ok' : 'check-warn') : 'check-idle'}`}>
          <div className="check-head">
            <span className="check-mark" aria-hidden>{tokenOk ? (apps && apps.length ? '✓' : '!') : '–'}</span>
            <strong>{t('pickApp')}</strong>
            <span className="check-state">{!tokenOk ? t('tokenFirst') : apps === null ? t('loading') : `${apps.length}`}</span>
          </div>
          {tokenOk && appsError !== null && <ErrorNotice error={appsError} />}
          {tokenOk && apps && apps.length === 0 && <Empty>{t('noApps')}</Empty>}
          {tokenOk && apps && apps.length > 0 && (
            <ul className="app-list">
              {apps.map((view) => (
                <li key={view.application.id}>
                  <a className="app-link" href={hrefFor(applicationPath(view.application.id))}>
                    <strong>{view.application.name}</strong>
                    <span className="small muted">{view.application.publicHost ?? view.application.slug}</span>
                    <span className="small muted">
                      {t('agent')} {view.agents.length}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ol>

      <section className="card card-collapsed">
        <Collapsible title={t('advanced')}>
          <GoTo />
        </Collapsible>
      </section>
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
      <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'application' | 'deployment')}>
        <option value="application">application id</option>
        <option value="deployment">deployment id</option>
      </select>
      <input className="input mono" placeholder="id" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
      <button type="submit" className="btn btn-small">{t('goto')}</button>
    </form>
  );
}
