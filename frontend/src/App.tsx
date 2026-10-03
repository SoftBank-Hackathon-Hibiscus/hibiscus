import { useEffect, useMemo, useRef, useState } from 'react';
import { createDataSource, readConfig } from './api';
import { TopBar } from './components/TopBar';
import { useConnection } from './hooks/useConnection';
import { LangProvider, useLang } from './lib/i18n';
import { fadeTextSwap } from './lib/motion';
import { useHashRoute } from './lib/router';
import { ApplicationDetail } from './pages/ApplicationDetail';
import { ApplicationList } from './pages/ApplicationList';
import { AgentList } from './pages/AgentList';
import { Connect } from './pages/Connect';
import { Demos } from './pages/Demos';
import { DeploymentDetail } from './pages/DeploymentDetail';
import { Home } from './pages/Home';
import { RegisterApplication } from './pages/RegisterApplication';

export function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}

function Shell() {
  const { lang } = useLang();
  // mode 가 없으면 real. 데모는 `?mode=mock&scenario=N` 일 때만, 그 query 를 가진 화면 안에서만 산다.
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

  // 첫 렌더는 건너뛰고, 언어를 바꿀 때만 본문과 열려 있는 모달 본문을 부드럽게 바꾼다 (reduced-motion 이면 생략)
  const mainRef = useRef<HTMLElement>(null);
  const langSeen = useRef(lang);
  useEffect(() => {
    if (langSeen.current === lang) return;
    langSeen.current = lang;
    fadeTextSwap([mainRef.current, document.querySelector('.modal-body')]);
  }, [lang]);

  return (
    <div className="app">
      <TopBar isReal={isReal} connection={connection.state} route={route} onTokenChange={onTokenChange} onReconnect={connection.recheck} />
      <main ref={mainRef}>
        {route.page === 'deployment' && <DeploymentDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'application' && <ApplicationDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} tab={route.tab} />}
        {route.page === 'applications' && <ApplicationList key={`apps-${tokenVersion}`} source={source} />}
        {route.page === 'agents' && <AgentList key={`agents-${tokenVersion}`} source={source} />}
        {route.page === 'register' && <RegisterApplication key={`register-${tokenVersion}`} source={source} />}
        {route.page === 'home' && <Home isReal={isReal} connection={connection.state} />}
        {route.page === 'demos' && <Demos />}
        {route.page === 'connect' && <Connect connection={connection.state} onRecheck={connection.recheck} />}
      </main>
    </div>
  );
}
