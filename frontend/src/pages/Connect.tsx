import { useState } from "react";
import { httpApi } from "../api/client";
import { loadTokens, parsePastedTokens, saveTokens, setMockMode } from "../api/session";
import type { User } from "../api/types";
import { Card, Mono } from "../components/ui";
import { href } from "../router";

export function Connect() {
  const stored = loadTokens();
  const [access, setAccess] = useState("");
  const [refresh, setRefresh] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    const tokens = parsePastedTokens(access, refresh);
    if (!tokens) {
      setMessage({ ok: false, text: "access_token 을 찾지 못함" });
      return;
    }
    setBusy(true);
    saveTokens(tokens);
    try {
      const user: User = await httpApi.me();
      setMockMode(false);
      setMessage({ ok: true, text: `${user.login} 로 연결됨` });
      window.location.hash = href.home();
      window.location.reload();
    } catch (error) {
      setMessage({ ok: false, text: `확인 실패: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    saveTokens(null);
    setMockMode(true);
    window.location.hash = href.home();
    window.location.reload();
  }

  return (
    <div className="stack narrow">
      <div className="page-head">
        <h1>백엔드 연결</h1>
        <p className="sub">로그인 콜백이 JSON만 돌려줘서, 받은 토큰을 여기에 붙여 넣음</p>
      </div>

      <Card title="토큰 붙여넣기">
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label>
            <span>access_token 또는 콜백 JSON 전체</span>
            <textarea
              rows={4}
              value={access}
              onChange={(event) => setAccess(event.target.value)}
              placeholder='eyJhbGciOi... 또는 {"access_token": "...", "refresh_token": "..."}'
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label>
            <span>refresh_token (선택, 401 때 한 번 갱신)</span>
            <input
              value={refresh}
              onChange={(event) => setRefresh(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "확인 중" : "연결"}
            </button>
            {stored && (
              <button className="btn" type="button" onClick={disconnect}>
                토큰 지우고 MOCK으로
              </button>
            )}
          </div>
          {message && <p className={message.ok ? "ok-text" : "danger-text"}>{message.text}</p>}
        </form>
      </Card>

      <Card title="토큰 받는 법">
        <ol className="howto">
          <li>
            브라우저에서 백엔드 주소로 직접 <Mono>GET /auth/github</Mono> 열기 (예: <Mono>http://localhost:8080/auth/github</Mono>).
            프록시(<Mono>/api</Mono>)를 거치면 state Cookie가 콜백까지 안 감
          </li>
          <li>
            응답의 <Mono>authorization_url</Mono> 로 이동해 GitHub 로그인
          </li>
          <li>
            콜백 화면의 JSON 전체를 복사해 위에 붙여넣기
          </li>
        </ol>
        <p className="sub">
          토큰은 이 브라우저 localStorage 에만 저장. 요청은 Vite 프록시 <Mono>/api</Mono> → <Mono>VITE_API_TARGET</Mono> 로 감
        </p>
      </Card>
    </div>
  );
}
