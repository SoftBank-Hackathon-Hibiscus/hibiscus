import { Flower2, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { configToSearch } from '../api';
import { readToken, writeToken } from '../api/token';
import type { ConnectionState } from '../hooks/useConnection';
import { useLang, type Lang } from '../lib/i18n';
import { APPLICATIONS_PATH, CONNECT_PATH, HOME_PATH, hrefFor, navigate, type Route } from '../lib/router';
import type { Tone } from '../lib/deployState';

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
 * 상단 바. 왼쪽 로고, 가운데 이동, 오른쪽 상태 pill 하나 + 사용자 메뉴 + KO|JA.
 * 토큰 문자열은 어디에도 보여주지 않는다. 좁은 화면에서는 메뉴 버튼 하나로 접는다.
 */
export function TopBar({ isReal, connection, route, onTokenChange, onReconnect }: TopBarProps) {
  const { t, lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const connected = isReal && connection.level === 'ok';
  const tokenPresent = isReal && (connection.level === 'ok' || (connection.level === 'login' && connection.tokenPresent)) && Boolean(readToken());

  // 경로가 바뀌면 접힌 메뉴를 닫는다
  useEffect(() => setOpen(false), [route]);

  const logout = () => {
    writeToken(null);
    setOpen(false);
    onTokenChange();
    navigate(CONNECT_PATH);
  };

  const navLinks = (
    <>
      <a className={`nav-link ${route.page === 'home' ? 'nav-link-on' : ''}`} href={hrefFor(HOME_PATH)} aria-current={route.page === 'home' ? 'page' : undefined}>
        {t('navHome')}
      </a>
      {connected && (
        <a
          className={`nav-link ${route.page === 'applications' || route.page === 'application' || route.page === 'register' || route.page === 'deployment' ? 'nav-link-on' : ''}`}
          href={hrefFor(APPLICATIONS_PATH)}
          aria-current={route.page === 'applications' ? 'page' : undefined}
        >
          {t('appsTitle')}
        </a>
      )}
    </>
  );

  const status = <StatusPill isReal={isReal} connection={connection} />;
  const langSwitch = <LangSwitch lang={lang} setLang={setLang} />;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href={hrefFor(HOME_PATH)}>
          <span className="brand-mark" aria-hidden>
            <Flower2 size={18} />
          </span>
          Hibiscus
        </a>
        <nav className="topbar-nav" aria-label={t('navMain')}>
          {navLinks}
        </nav>
        <div className="topbar-right">
          {status}
          {isReal && tokenPresent ? (
            <UserMenu connection={connection} onReconnect={onReconnect} onLogout={logout} />
          ) : isReal ? (
            <a className="nav-link" href={hrefFor(CONNECT_PATH)}>
              {t('connectLink')}
            </a>
          ) : (
            <a className="nav-link" href={`${configToSearch({ mode: 'real', scenario: 1 })}#${CONNECT_PATH}`}>
              {t('connectLink')}
            </a>
          )}
          {langSwitch}
        </div>
        <button type="button" className="topbar-burger" aria-expanded={open} aria-controls="topbar-panel" aria-label={open ? t('menuClose') : t('menuOpen')} onClick={() => setOpen((v) => !v)}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {open && (
        <div id="topbar-panel" className="topbar-panel">
          <div className="topbar-panel-row">{status}</div>
          <nav className="topbar-panel-nav" aria-label={t('navMain')}>
            {navLinks}
            {isReal && !tokenPresent && (
              <a className="nav-link" href={hrefFor(CONNECT_PATH)}>
                {t('connectLink')}
              </a>
            )}
            {!isReal && (
              <a className="nav-link" href={`${configToSearch({ mode: 'real', scenario: 1 })}#${CONNECT_PATH}`}>
                {t('connectLink')}
              </a>
            )}
          </nav>
          {isReal && tokenPresent && (
            <div className="topbar-panel-nav">
              {connection.level === 'ok' && <UserLine connection={connection} />}
              <button type="button" className="nav-link nav-btn" onClick={onReconnect}>
                {t('menuReconnect')}
              </button>
              <button type="button" className="nav-link nav-btn" onClick={logout}>
                {t('menuLogout')}
              </button>
            </div>
          )}
          <div className="topbar-panel-row">{langSwitch}</div>
        </div>
      )}
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

/** 상태 pill 하나. mock 은 항상 "데모", real 은 연결 확인 결과 그대로. 실패해도 mock 으로 돌아가지 않는다. */
function StatusPill({ isReal, connection }: { isReal: boolean; connection: ConnectionState }) {
  const { t } = useLang();
  if (!isReal) return <Status tone="warning" title={t('statusDemoTitle')}>{t('statusDemo')}</Status>;
  switch (connection.level) {
    case 'checking':
      return <Status tone="muted">{t('connChecking')}</Status>;
    case 'down':
      return <Status tone="danger" title={connection.detail}>{t('statusDown')}</Status>;
    case 'login':
      return <Status tone="warning" title={connection.detail}>{t('statusLogin')}</Status>;
    case 'ok':
      return <Status tone="success">{t('statusConnected')}</Status>;
  }
}

function Status({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={`status-pill status-${tone}`} title={title}>
      <span className="status-dot" aria-hidden />
      {children}
    </span>
  );
}

function UserLine({ connection }: { connection: Extract<ConnectionState, { level: 'ok' }> }) {
  const user = connection.user;
  return (
    <div className="user-line">
      <Avatar login={user.login} avatarUrl={user.avatarUrl} size={28} />
      <span className="user-line-text">
        <strong>@{user.login}</strong>
        {user.name && <span className="small muted">{user.name}</span>}
      </span>
    </div>
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
          {user ? (
            <div className="menu-head">
              <Avatar login={user.login} avatarUrl={user.avatarUrl} size={36} />
              <span className="user-line-text">
                <strong>@{user.login}</strong>
                {user.name && <span className="small muted">{user.name}</span>}
              </span>
            </div>
          ) : (
            <div className="menu-head">
              <span className="small muted">{t('menuNotVerified')}</span>
            </div>
          )}
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
