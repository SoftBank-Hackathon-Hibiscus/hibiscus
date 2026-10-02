import { useMemo, useState } from 'react';
import { configToSearch, createDataSource, readConfig } from './api';
import { TokenBar } from './components/TokenBar';
import { DemoBadge } from './components/ui';
import { useConnection, type ConnectionState } from './hooks/useConnection';
import { scenarioSummaries } from './mocks';
import { hrefFor, useHashRoute } from './lib/router';
import { ApplicationDetail } from './pages/ApplicationDetail';
import { Connect } from './pages/Connect';
import { DeploymentDetail } from './pages/DeploymentDetail';
import { Launcher } from './pages/Launcher';

export function App() {
  const config = useMemo(() => readConfig(), []);
  const [tokenVersion, setTokenVersion] = useState(0);
  const source = useMemo(() => createDataSource(config), [config]);
  const route = useHashRoute();
  const scenarios = useMemo(() => scenarioSummaries(), []);
  const isReal = config.mode === 'real';
  const connection = useConnection(source, tokenVersion, isReal ? 15000 : 3_600_000);
  const onTokenChange = () => setTokenVersion((v) => v + 1);

  return (
    <div className={`app ${isReal ? '' : 'app-demo'}`}>
      <nav className="topbar">
        <div className="topbar-left">
          <a className="brand" href={hrefFor('')}>Hibiscus</a>
          {!isReal && <DemoBadge />}
          {isReal && <ConnectionPill state={connection.state} />}
        </div>
        <div className="topbar-right">
          {!isReal && (
            <div className="scenarios">
              {scenarios.map((s) => (
                <a key={s.id} className={`scenario ${s.id === config.scenario && route.page !== 'none' ? 'scenario-current' : ''}`} href={`${configToSearch({ mode: 'mock', scenario: s.id })}#${s.defaultPath}`} title={s.description}>
                  {s.title}
                </a>
              ))}
            </div>
          )}
          {isReal && (
            <>
              {route.page !== 'none' && <TokenBar onChange={onTokenChange} />}
              <a className="scenario" href={`${configToSearch({ mode: 'mock', scenario: 1 })}#`}>데모로 돌아가기</a>
            </>
          )}
        </div>
      </nav>
      <main>
        {route.page === 'deployment' && <DeploymentDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'application' && <ApplicationDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'none' && !isReal && <Launcher />}
        {route.page === 'none' && isReal && <Connect source={source} connection={connection.state} onTokenChange={onTokenChange} onRecheck={connection.recheck} />}
      </main>
    </div>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  switch (state.level) {
    case 'checking':
      return <span className="conn conn-muted">연결 확인 중</span>;
    case 'down':
      return (
        <span className="conn conn-danger" title={state.detail}>
          <span className="conn-dot" /> 백엔드 연결 안 됨
        </span>
      );
    case 'login':
      return (
        <span className="conn conn-warning" title={state.detail}>
          <span className="conn-dot" /> 로그인 필요
        </span>
      );
    case 'ok':
      return (
        <span className="conn conn-success">
          <span className="conn-dot" /> 실제 백엔드 연결됨, @{state.user.login}
        </span>
      );
  }
}
