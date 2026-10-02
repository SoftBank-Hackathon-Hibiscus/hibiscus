import type { ReactNode } from "react";
import { api, MOCK } from "../api";
import { ApiError } from "../api/client";
import { loadTokens, setMockMode } from "../api/session";
import { usePolling } from "../hooks";
import { href } from "../router";
import { Icon } from "./Icon";

function switchMode(mock: boolean) {
  setMockMode(mock);
  // URL 의 ?mock= 이 있으면 그 값이 이기므로 삭제
  const url = new URL(window.location.href);
  url.searchParams.delete("mock");
  const [path, query = ""] = url.hash.split("?");
  const hashQuery = new URLSearchParams(query);
  hashQuery.delete("mock");
  const rest = hashQuery.toString();
  url.hash = `${!mock && !loadTokens() ? "#/connect" : path}${rest ? `?${rest}` : ""}`;
  window.history.replaceState(null, "", url.toString());
  window.location.reload();
}

export function Layout({ children }: { children: ReactNode }) {
  const me = usePolling(() => api.me(), null, MOCK ? "mock" : "live");
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={href.home()}>
            <span className="brand-mark" aria-hidden="true" />
            Hibiscus
          </a>
          {MOCK && (
            <span className="mock-badge" title="시연용 가짜 데이터. 실제 백엔드와 연결되지 않음">
              MOCK
            </span>
          )}
          <nav className="topnav">
            <a href={href.home()}>앱</a>
            <a href={href.connect()}>연결</a>
          </nav>
          <div className="topbar-right">
            <button
              type="button"
              className="mode-toggle"
              onClick={() => switchMode(!MOCK)}
              title={MOCK ? "백엔드에 연결" : "mock 데이터로 보기"}
            >
              <span className={`switch ${MOCK ? "" : "on"}`} aria-hidden="true" />
              {MOCK ? "Mock" : "Live"}
            </button>
            {me.data ? (
              <span className="me" title={me.data.id}>
                <Icon name="dot" size={10} className={MOCK ? "muted" : "ok"} />
                {me.data.login}
              </span>
            ) : !MOCK && me.error ? (
              <a className="me warn" href={href.connect()}>
                {me.error instanceof ApiError && me.error.status === 401 ? "토큰 확인 필요" : "백엔드 연결 안 됨"}
              </a>
            ) : null}
          </div>
        </div>
        {MOCK && (
          <div className="mock-strip">
            MOCK 모드: 화면의 실행 기록·상태는 시연용 데이터 (frontend/src/mocks)
          </div>
        )}
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
