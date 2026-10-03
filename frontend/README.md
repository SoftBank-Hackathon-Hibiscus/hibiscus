# frontend

데모용 최소 UI. 화면은 두 개다.

- **Deployment Detail** `#/deployments/<id>`: test → policy → sign → deploy 타임라인, 정책 결정과 고칠 것(requires), 서명, 배포 결과, 감사 기록, 산출물
- **Application Detail** `#/applications/<id>`: 현재 route, On-Prem / Cloud Run target 과 health, failover 감지, 에이전트 상태, 배포 목록

Vite + React + TypeScript. 상태관리·UI 라이브러리 없음. 화면 명세는 [SPEC.md](SPEC.md).

## 실행

```powershell
cd frontend
npm install
npm run dev
```

`http://127.0.0.1:5173` 이 열린다. 루트는 **Demo Launcher** (mock 시나리오 5개를 고르는 시작판)이고, 상단에 DEMO DATA 배지가 항상 보인다. 상단 바의 KO / JA 로 화면 라벨과 정책 문구(reason_i18n, hint_i18n, explain.ja)를 한 언어로 바꾼다. 아이콘은 lucide-react 하나만 쓴다.

| 명령 | 내용 |
|---|---|
| `npm run dev` | 개발 서버 (프록시 포함) |
| `npm run build` | 타입체크 + 번들 → `dist/` |
| `npm run preview` | `dist/` 를 같은 프록시 설정으로 서빙 (데모 머신용) |
| `npm run lint` | `tsc --noEmit` |

## mock 모드

`?mode=mock&scenario=N` 으로 고른다. 상단 바에서도 바꿀 수 있다.

| 시나리오 | URL | 내용 |
|---|---|---|
| ① 방명록 차단 | `/?mode=mock&scenario=1#/deployments/dep-0001-guestbook-block` | restart 14/20 → block. requires: fix_restart_failure, managed_db, object_storage |
| ② 허용 → 배포 완료 | `/?mode=mock&scenario=2#/deployments/dep-0002-guestbook-allow` | allow → activated, 온프레 primary / Cloud Run standby |
| ③ 후보 실패 → 보류 | `/?mode=mock&scenario=3#/deployments/dep-0003-guestbook-held` | v3 Cloud Run 후보 health 503 → held, v2 서비스 유지 |
| ④ 온프레 장애 → failover | `/?mode=mock&scenario=4#/applications/a4f3c2e1-0000-4000-8000-00000000ab01` | 5초마다 healthy → unknown → unhealthy → route 가 Cloud Run 으로 (rev 1 → 2). 새로고침하면 처음부터 |
| ⑤ 승인 필요 → 온프레 배포 | `/?mode=mock&scenario=5` | 승인 후에도 온프레만 배포하며 Cloud Run failover는 차단 |

mock 데이터는 `src/mocks/` 에 있고 실제 API 응답과 같은 구조다. 화면 컴포넌트는 mock/real 을 구분하지 않는다 (`src/api/client.ts` 의 `DataSource` 인터페이스만 본다).

## real API 모드

1. 백엔드를 정한다. 프록시가 그 주소로 전달하므로 프론트 코드는 바뀌지 않는다.
   - 로컬 backend-v2 를 띄우는 경우: 기본값 `http://127.0.0.1:8080` 그대로 쓰면 된다.
   - 팀 VM 을 쓰는 경우: `.env.example` 을 `.env.local` 로 복사해 `VITE_BACKEND_URL=https://api.hibiscus.lth.so` 로 바꾸고 dev 서버를 다시 시작한다. VM 의 8080 은 내부 전용이라 `http://<vm-host>:8080` 은 닿지 않는다. 원격 주소면 프록시가 Host 헤더를 대상으로 바꿔 보내 Caddy 를 통과한다.

   ```powershell
   cd frontend; Copy-Item .env.example .env.local; # VITE_BACKEND_URL 수정 후
   npm run dev
   ```
2. `http://127.0.0.1:5173/?mode=real` 로 연다. 백엔드 → 토큰 → 앱 선택 체크리스트가 뜨고, 상단 표시는 `/healthz` 가 `{ok:true}` 를 돌려주지 않으면 빨강 "백엔드 연결 안 됨", 토큰이 없거나 401 이면 주황 "로그인 필요", `/users/me` 가 성공할 때만 초록 "실제 백엔드 연결됨"이다. 실패해도 mock 으로 되돌아가지 않는다.
3. access token 을 구한다: 브라우저로 OAuth 시작 주소를 연다 → `authorization_url` 로 이동 → GitHub 로그인 → 콜백이 JSON 을 돌려주는데 그 안의 `access_token` 을 복사한다. (콜백은 리다이렉트하지 않는다.)
   - 로컬 backend-v2: `http://127.0.0.1:8080/auth/github`
   - 팀 VM: 반드시 `https://api.hibiscus.lth.so/auth/github` 에서 시작한다. GitHub App 콜백이 `api.hibiscus.lth.so` 로 등록돼 있고 state 쿠키도 그 호스트의 `/auth/github` 경로에 붙는다. 5173 프록시나 `127.0.0.1` 에서 시작하면 쿠키가 콜백 호스트로 가지 않아 콜백에서 401 이 난다.
4. 상단 입력칸에 콜백 JSON 전체 또는 access token을 붙여 저장한다. JSON 전체를 넣으면 refresh token도 저장된다. `localStorage`에 보관하며 API 요청은 `Authorization: Bearer`로 보낸다.
5. 토큰이 유효하면 `GET /applications` 목록이 보이고 클릭하면 이동한다. id 직접 입력은 "고급"에 있다.

access token은 기본 15분 만료다. refresh token이 있으면 401 응답 시 한 번 갱신하고 원 요청을 한 번 재시도한다. refresh token이 없거나 갱신에 실패하면 다시 로그인한다.

CORS: backend-v2 는 CORS 를 켜지 않는다. `vite.config.ts` 의 프록시가 `/auth, /applications, /deployments, /agents, /users, /healthz` 를 백엔드로 넘겨 같은 origin 으로 보이게 한다. `npm run preview` 도 같은 프록시를 쓴다. 원격 HTTPS 연결은 인증서를 검증한다. OAuth 로그인 시작은 위 안내대로 backend 주소를 직접 사용한다.

## 쓰는 API

| Method | Path | 화면 |
|---|---|---|
| GET | `/deployments/:id` | Deployment Detail 전체 (deployment, stages, policyResult, artifacts.content, auditLogs) |
| POST | `/deployments/:id/approve` | 승인 버튼 |
| GET | `/applications/:id` | 두 화면의 앱 이름·health 설정·에이전트 목록 |
| GET | `/applications/:id/deployments` | Application Detail 배포 목록 |
| GET | `/applications/:id/routing` | 현재 route (첫 전환 전 404 → "경로 없음") |
| GET | `/applications/:id/targets` | target 과 health |
| GET | `/agents/:id/status` | 에이전트 online/offline, 서빙 중 컨테이너 (앱에 에이전트가 없으면 호출 안 함) |

폴링: Deployment Detail 은 queued/running/awaiting_approval 일 때만 2초, Application Detail 은 5초.

## 폴더

```
src/
  api/        DataSource 인터페이스, real(fetch)·mock 구현, 응답 타입, 산출물 계약 타입
  mocks/      시나리오 5개 (실제 API 응답 구조)
  lib/        산출물 선택·parse, deploy 상태 판정, 포맷, 해시 라우터
  hooks/      usePolling
  components/ Badge, Hash(클릭 복사), Kv, Notice, Collapsible, TokenBar
  pages/      DeploymentDetail, ApplicationDetail
```
