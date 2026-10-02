import { useEffect, useMemo, useState } from 'react';
import { configToSearch, createDataSource, readConfig } from './api';
import { MockDataSource } from './api/mock';
import { TokenBar } from './components/TokenBar';
import { Badge } from './components/ui';
import { scenarioSummaries } from './mocks';
import { applicationPath, deploymentPath, hrefFor, navigate, useHashRoute } from './lib/router';
import { ApplicationDetail } from './pages/ApplicationDetail';
import { DeploymentDetail } from './pages/DeploymentDetail';

export function App() {
  const config = useMemo(() => readConfig(), []);
  const [tokenVersion, setTokenVersion] = useState(0);
  const source = useMemo(() => createDataSource(config), [config]);
  const route = useHashRoute();
  const scenarios = useMemo(() => scenarioSummaries(), []);

  useEffect(() => {
    if (route.page === 'none' && source instanceof MockDataSource) navigate(source.scenario.defaultPath);
  }, [route.page, source]);

  return (
    <div className="app">
      <nav className="topbar">
        <div className="topbar-left">
          <a className="brand" href={hrefFor('')}>Hibiscus</a>
          <span className="brand-sub">데모 콘솔</span>
          {config.mode === 'mock' ? <Badge tone="info">mock</Badge> : <Badge tone="success">real API</Badge>}
        </div>
        <div className="topbar-right">
          {config.mode === 'mock' && (
            <div className="scenarios">
              {scenarios.map((s) => (
                <a
                  key={s.id}
                  className={`scenario ${s.id === config.scenario ? 'scenario-current' : ''}`}
                  href={`${configToSearch({ mode: 'mock', scenario: s.id })}#${s.defaultPath}`}
                  title={s.description}
                >
                  {s.title}
                </a>
              ))}
              <a className="scenario scenario-real" href={`${configToSearch({ mode: 'real', scenario: 1 })}#`}>real API</a>
            </div>
          )}
          {config.mode === 'real' && (
            <>
              <TokenBar onChange={() => setTokenVersion((v) => v + 1)} />
              <a className="scenario" href={`${configToSearch({ mode: 'mock', scenario: 1 })}#`}>mock 으로</a>
            </>
          )}
        </div>
      </nav>
      <GoTo />
      <main>
        {route.page === 'deployment' && <DeploymentDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'application' && <ApplicationDetail key={`${route.id}-${tokenVersion}`} id={route.id} source={source} />}
        {route.page === 'none' && config.mode === 'real' && (
          <div className="page">
            <div className="card">
              <h2 className="h2">실제 백엔드에 연결</h2>
              <ol className="plain">
                <li>백엔드가 Vite 프록시 대상(기본 http://127.0.0.1:8080)에서 실행 중이어야 함</li>
                <li>위 입력칸에 access token 을 붙여넣고 저장</li>
                <li>아래에 application id 또는 deployment id 를 넣고 이동</li>
              </ol>
            </div>
          </div>
        )}
      </main>
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
        setValue('');
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
