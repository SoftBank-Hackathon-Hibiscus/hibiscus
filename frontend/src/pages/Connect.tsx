import { useEffect, useState } from 'react';
import type { DataSource } from '../api/client';
import type { ApplicationView } from '../api/types';
import { TokenBar } from '../components/TokenBar';
import { ErrorNotice } from '../components/ErrorNotice';
import { Collapsible, Empty } from '../components/ui';
import type { ConnectionState } from '../hooks/useConnection';
import { applicationPath, deploymentPath, hrefFor, navigate } from '../lib/router';

/** real 모드 홈. 백엔드 → 토큰 → 앱 선택 순서의 체크리스트. 실패해도 mock 으로 돌아가지 않는다. */
export function Connect({ source, connection, onTokenChange, onRecheck }: { source: DataSource; connection: ConnectionState; onTokenChange: () => void; onRecheck: () => void }) {
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
      <header className="launcher-hero compact">
        <h1>실제 백엔드에 연결</h1>
        <p className="tagline">세 가지가 차례로 준비되어야 화면이 실제 데이터를 보여줍니다.</p>
      </header>

      <ol className="checklist">
        <li className={`check-item ${connection.level === 'checking' ? '' : backendOk ? 'check-ok' : 'check-fail'}`}>
          <div className="check-head">
            <span className="check-mark" aria-hidden>{connection.level === 'checking' ? '…' : backendOk ? '✓' : '✕'}</span>
            <strong>백엔드</strong>
            <span className="check-state">
              {connection.level === 'checking' && '확인 중'}
              {connection.level === 'down' && '연결 안 됨'}
              {backendOk && '응답함'}
            </span>
            <button type="button" className="btn btn-small" onClick={onRecheck}>다시 확인</button>
          </div>
          {connection.level === 'down' && (
            <p className="check-help">
              GET /healthz 가 응답하지 않습니다. backend-v2를 실행하고, 주소가 다르면 <code>frontend/.env.local</code>의 <code>VITE_BACKEND_URL</code>을 바꾼 뒤 개발 서버를 다시 시작하세요. ({connection.detail})
            </p>
          )}
        </li>

        <li className={`check-item ${!backendOk ? 'check-idle' : tokenOk ? 'check-ok' : 'check-warn'}`}>
          <div className="check-head">
            <span className="check-mark" aria-hidden>{!backendOk ? '–' : tokenOk ? '✓' : '!'}</span>
            <strong>토큰</strong>
            <span className="check-state">
              {!backendOk && '백엔드 먼저'}
              {backendOk && connection.level === 'login' && (connection.tokenPresent ? '유효하지 않음' : '로그인 필요')}
              {tokenOk && `@${connection.user.login}`}
            </span>
          </div>
          {backendOk && !tokenOk && (
            <div className="check-body">
              <p className="check-help">
                브라우저로 <code>/auth/github</code> 를 열어 <code>authorization_url</code> 로 이동하고, GitHub 로그인 뒤 콜백 JSON의 <code>access_token</code> 을 아래에 붙여넣으세요. 기본 만료는 15분입니다.
                {connection.level === 'login' && connection.tokenPresent && ` (${connection.detail})`}
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

        <li className={`check-item ${tokenOk ? (apps && apps.length ? 'check-ok' : 'check-warn') : 'check-idle'}`}>
          <div className="check-head">
            <span className="check-mark" aria-hidden>{tokenOk ? (apps && apps.length ? '✓' : '!') : '–'}</span>
            <strong>앱 선택</strong>
            <span className="check-state">{!tokenOk ? '토큰 먼저' : apps === null ? '불러오는 중' : `${apps.length}개`}</span>
          </div>
          {tokenOk && appsError !== null && <ErrorNotice error={appsError} />}
          {tokenOk && apps && apps.length === 0 && <Empty>등록된 애플리케이션이 없습니다. 백엔드에서 POST /applications 로 먼저 만드세요.</Empty>}
          {tokenOk && apps && apps.length > 0 && (
            <ul className="app-list">
              {apps.map((view) => (
                <li key={view.application.id}>
                  <a className="app-link" href={hrefFor(applicationPath(view.application.id))}>
                    <strong>{view.application.name}</strong>
                    <span className="small muted">{view.application.publicHost ?? view.application.slug}</span>
                    <span className="small muted">에이전트 {view.agents.length}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </li>
      </ol>

      <Collapsible title="고급: id 직접 입력">
        <GoTo />
      </Collapsible>
    </div>
  );
}

function GoTo() {
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
      <input className="input mono" placeholder="id 입력 후 Enter" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
      <button type="submit" className="btn btn-small">이동</button>
    </form>
  );
}
