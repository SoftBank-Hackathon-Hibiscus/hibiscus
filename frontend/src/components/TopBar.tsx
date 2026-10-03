import { Flower2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readToken } from '../api/token';
import type { ConnectionState } from '../hooks/useConnection';
import type { Tone } from '../lib/deployState';
import { useLang, type Lang } from '../lib/i18n';
import { CONNECT_PATH, DEMOS_PATH, HOME_PATH, realHref, type Route } from '../lib/router';
import { signOut } from '../lib/session';

interface TopBarProps {
  isReal: boolean;
  connection: ConnectionState;
  route: Route;
  /** 토큰이 바뀐 뒤 화면을 다시 그리게 한다 */
  onTokenChange: () => void;
  /** /healthz → /users/me 를 다시 확인 */
  onReconnect: () => void;
}

/**
 * 상단 바. 왼쪽 로고(= 홈), 오른쪽에 사용자 또는 로그인, KO|JA.
 * 정상 연결은 서비스의 기본 상태라 아무것도 띄우지 않고, 문제가 있을 때만 상태 pill 을 보인다.
 * 데모 모드에서는 DEMO pill 이 항상 보인다. 로고와 로그인은 query 를 떼고 real 로 돌아간다.
 * 토큰 문자열은 어디에도 보여주지 않는다.
 */
export function TopBar({ isReal, connection, route, onTokenChange, onReconnect }: TopBarProps) {
  const { t, lang, setLang } = useLang();
  const tokenPresent = isReal && Boolean(readToken());

  // 어디서 눌러도 홈으로. 토큰이 바뀌면 Shell 이 화면을 다시 그려 이전 화면 데이터가 남지 않는다.
  const logout = () => {
    signOut();
    onTokenChange();
  };

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href={realHref(HOME_PATH)} aria-label="Hibiscus">
          <span className="brand-mark" aria-hidden>
            <Flower2 size={18} />
          </span>
          Hibiscus
        </a>
        <div className="topbar-right">
          {!isReal && (
            <a className={`status-pill status-warning status-link ${route.page === 'demos' ? 'status-on' : ''}`} href={realHref(DEMOS_PATH)} title={t('statusDemoTitle')}>
              <span className="status-dot" aria-hidden />
              DEMO
            </a>
          )}
          {isReal && <ProblemPill connection={connection} />}
          {isReal && tokenPresent && <UserMenu connection={connection} onReconnect={onReconnect} onLogout={logout} />}
          {isReal && !tokenPresent && route.page !== 'connect' && (
            <a className="btn btn-primary btn-small" href={realHref(CONNECT_PATH)}>
              {t('loginAction')}
            </a>
          )}
          <LangSwitch lang={lang} setLang={setLang} />
        </div>
      </div>
    </header>
  );
}

function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  return (
    <div className="lang-switch" role="group" aria-label="language">
      <button type="button" className={lang === 'ko' ? 'lang-on' : ''} onClick={() => setLang('ko')} aria-pressed={lang === 'ko'}>
        KO
      </button>
      <button type="button" className={lang === 'ja' ? 'lang-on' : ''} onClick={() => setLang('ja')} aria-pressed={lang === 'ja'}>
        JA
      </button>
    </div>
  );
}

/** 문제가 있을 때만 보이는 상태 pill. 확인 중·정상·토큰 없음은 조용히 지나간다. */
function ProblemPill({ connection }: { connection: ConnectionState }) {
  const { t } = useLang();
  if (connection.level === 'down') return <Status tone="danger" title={connection.detail}>{t('statusDown')}</Status>;
  if (connection.level === 'login' && connection.tokenPresent) return <Status tone="warning" title={connection.detail}>{t('statusExpired')}</Status>;
  return null;
}

function Status({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={`status-pill status-${tone}`} title={title}>
      <span className="status-dot" aria-hidden />
      {children}
    </span>
  );
}

function Avatar({ login, avatarUrl, size }: { login: string; avatarUrl: string | null; size: number }) {
  if (avatarUrl) return <img className="avatar" src={avatarUrl} alt="" width={size} height={size} />;
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size }} aria-hidden>
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 사용자 드롭다운. 바깥 클릭·Esc 로 닫힌다. 로그아웃은 이 브라우저의 토큰만 지운다. */
function UserMenu({ connection, onReconnect, onLogout }: { connection: ConnectionState; onReconnect: () => void; onLogout: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const user = connection.level === 'ok' ? connection.user : null;
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('userMenuLabel')} onClick={() => setOpen((v) => !v)}>
        {user ? <Avatar login={user.login} avatarUrl={user.avatarUrl} size={26} /> : <span className="avatar avatar-fallback avatar-unknown" style={{ width: 26, height: 26 }} aria-hidden>?</span>}
        {user && <span className="menu-login">@{user.login}</span>}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-head">
            {user ? (
              <>
                <Avatar login={user.login} avatarUrl={user.avatarUrl} size={36} />
                <span className="user-line-text">
                  <strong>@{user.login}</strong>
                  {user.name && <span className="small muted">{user.name}</span>}
                </span>
              </>
            ) : (
              <span className="small muted">{t('menuNotVerified')}</span>
            )}
          </div>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReconnect();
            }}
          >
            {t('menuReconnect')}
          </button>
          <button type="button" className="menu-item" role="menuitem" onClick={onLogout}>
            <span>{t('menuLogout')}</span>
            <span className="small muted">{t('menuLogoutNote')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
