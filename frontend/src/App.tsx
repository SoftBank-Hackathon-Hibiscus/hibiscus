import { Flower2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { configToSearch, createDataSource, readConfig } from './api';
import { TokenBar } from './components/TokenBar';
import { DemoBadge } from './components/ui';
import { useConnection, type ConnectionState } from './hooks/useConnection';
import { LangProvider, useLang } from './lib/i18n';
import { APPLICATIONS_PATH, hrefFor, useHashRoute } from './lib/router';
import { ApplicationDetail } from './pages/ApplicationDetail';
import { ApplicationList } from './pages/ApplicationList';
import { Connect } from './pages/Connect';
import { DeploymentDetail } from './pages/DeploymentDetail';
import { Launcher } from './pages/Launcher';
import { RegisterApplication } from './pages/RegisterApplication';

export function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}

function Shell() {
  const { lang, setLang, t } = useLang();
  const config = useMemo(() => readConfig(), []);
  const [tokenVersion, setTokenVersion] = useState(0);
  const source = useMemo(() => createDataSource(config), [config]);
  const route = useHashRoute();
  const isReal = config.mode === 'real';
  const connection = useConnection(source, tokenVersion, isReal ? 15000 : 3_600_000);
  const onTokenChange = () => setTokenVersion((v) => v + 1);

  // 한국어는 단어 중간에서 끊지 않고(keep-all), 일본어는 기본 줄바꿈. CSS 가 html[lang] 을 본다.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <div className="app">
      <nav className="topbar">
        <div className="topbar-inner">
        <div className="topbar-left">
          <a className="brand" href={hrefFor('')}>
            <span className="brand-mark" aria-hidden>
              <Flower2 size={18} />
            </span>
            Hibiscus
          </a>
          {!isReal && <DemoBadge />}
          {isReal && <ConnectionPill state={connection.state} />}
        </div>
        <div className="topbar-right">
          {isReal && route.page !== 'none' && <TokenBar onChange={onTokenChange} />}
          {isReal && connection.state.level === 'ok' && route.page !== 'applications' && (
            <a className="topbar-link" href={hrefFor(APPLICATIONS_PATH)}>{t('appsTitle')}</a>
          )}
          {isReal ? (
            <a className="topbar-link" href={`${configToSearch({ mode: 'mock', scenario: 1 })}#`}>{t('backToDemo')}</a>
          ) : (
            route.page !== 'none' && <a className="topbar-link" href={hrefFor('')}>{t('backToDemo')}</a>
          )}
          <div className="lang-switch" role="group" aria-label="language">
            <button type="button" className={lang === 'ko' ? 'lang-on' : ''} onClick={() => setLang('ko')}>KO</button>
            <button type="button" className={lang === 'ja' ? 'lang-on' : ''} onClick={() => setLang('ja')}>JA</button>
          </div>
        </div>
        </div>
      </nav>
      <main>
        {route.page === 'deployment' && <DeploymentDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'application' && <ApplicationDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'applications' && <ApplicationList key={`apps-${tokenVersion}`} source={source} />}
        {route.page === 'register' && <RegisterApplication key={`register-${tokenVersion}`} source={source} />}
        {route.page === 'none' && !isReal && <Launcher />}
        {route.page === 'none' && isReal && <Connect source={source} connection={connection.state} onTokenChange={onTokenChange} onRecheck={connection.recheck} />}
      </main>
    </div>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const { t } = useLang();
  switch (state.level) {
    case 'checking':
      return <span className="conn conn-muted">{t('connChecking')}</span>;
    case 'down':
      return (
        <span className="conn conn-danger" title={state.detail}>
          <span className="conn-dot" /> {t('connDown')}
        </span>
      );
    case 'login':
      return (
        <span className="conn conn-warning" title={state.detail}>
          <span className="conn-dot" /> {t('connLogin')}
        </span>
      );
    case 'ok':
      return (
        <span className="conn conn-success">
          <span className="conn-dot" /> {t('connOk')} @{state.user.login}
        </span>
      );
  }
}
