# backend-v2

Nest CLI로 생성한 하이브리드 배포 백엔드 재구현 초안입니다.

기존 `backend`를 대체하지 않습니다. 현재 코드를 검토한 뒤에 교체 여부를 정합니다.

## 현재 구현 범위

- Application 등록과 조회
- Application별 Docker container port 설정
- Application별 Deployment Version 생성과 조회
- Application별 Health Check 설정
- Agent 등록과 Application 할당
- Agent token 인증·교체·폐기
- Agent 작업 폴링·lease·결과 제출·heartbeat와 상태 조회
- Application별 On-Prem·Cloud Run Routing Target과 현재 Route 저장
- Revision 확인을 사용하는 수동 Route 변경과 변경 이력 저장
- Health Monitor가 전달할 Target Health 저장과 만료 처리
- Application Host 기반 Reverse Proxy
- On-Prem SSH Tunnel·Cloud Run 요청 전달과 스트리밍
- Application별 임계값을 사용하는 Health Monitor와 On-Prem → Cloud Run 자동 Failover
- Agent가 `ssh2` Node 모듈로 만드는 outbound SSH Reverse Tunnel
- 앱별 VM loopback 전달 포트 할당과 연결 상태 확인
- SQLite 작업함을 확인하는 배포 Worker
- `test → policy → sign → deploy` 단계 실행과 시도별 기록
- 정책 결과 `allow`, `needs_approval`, `block`
- Policy Result 별도 저장
- 결과 JSON·설명 문서의 원문과 SHA-256 해시를 DB에 저장
- 정책·서명 감사 로그를 DB에 추가 기록
- 배포 요청의 커밋 SHA(`source_revision`) 필수 입력
- 승인 필요 실행의 대기와 승인 처리
- 요청자와 승인자 분리
- GitHub App의 OAuth Authorization Code + PKCE 로그인
- 고정 사용자 ID와 JWT 기반 관리 API 인증
- 서버 재시작 시 `running` 작업을 다시 `queued`로 변경
- DTO와 `class-validator` 기반 요청 검증
- Zod 기반 환경 변수 검증
- Drizzle 기반 SQLite 영구 저장

`test`는 현재 Fixture 결과를 생성합니다. 실제 테스트 실행기는 아직 연결하지 않았습니다.
`policy`, `sign`은 기본 설정에서 내부 Stub을 사용합니다. CLI 모드에서는 기존 도구를 실행합니다.

`deploy`는 아직 실제 배포를 실행하지 않습니다. 실행 결과에 `skipped`로 기록합니다.

## 구조

```text
src/
├── config/configs/  registerAs 설정 팩토리와 환경 변수 검증
├── database/     Drizzle 스키마와 DB 연결
├── infrastructure/
│   └── command-runner.ts
├── application/  Project와 Health Check
├── deployment/   Version, Pipeline, Stage, Policy Result
├── agent/        Agent와 Application 연결
├── routing/      Target, 현재 Route, Health 상태
├── ssh-tunnel/   내장 SSH 서버, loopback 전달과 상태 확인
├── gateway/      Host 선택과 On-Prem·Cloud Run Reverse Proxy
├── health/       Target 점검과 자동 Failover
├── auth/         GitHub 로그인, JWT 발급·검증·갱신
├── user/         GitHub 계정과 고정 사용자 ID
├── app.module.ts
└── main.ts
```

역할은 다음과 같이 분리합니다.

- 각 Feature는 Controller, Service, Repository, Module을 가집니다. DTO는 `dto/`, 공통 배포 계약과 경로는 `deployment/types/`, 단위 테스트는 `specs/`에 둡니다.
- 서비스 파일에는 서비스 클래스 하나만 둡니다. 인증 가드는 `auth/guards/jwt-auth.guard.ts`에 둡니다.
- Deployment의 `stages/`가 단계별 실행 책임을 가집니다.
- 공통 명령 실행은 `infrastructure/`에 둡니다. 계약 스키마 검사는 테스트에서만 수행합니다.
- 수동 요청과 HMAC을 검증한 GitHub Push Webhook 모두 처음에는 `sourceRevisionVerified=false`입니다. 웹훅 검증은 요청의 출처를 확인하며 실제 시험한 이미지의 소스를 증명하지 않습니다. registry parity가 run ID·소스 SHA·digest를 대조하고 산출물 저장까지 성공한 뒤에만 `true`가 됩니다. 이 값은 이미지와 소스의 연결을 뜻하며, 앱 테스트 통과 여부와 배포 허용 여부는 별도로 판단합니다. 실서명과 실배포에는 이 값과 registry digest가 모두 필요합니다.

## 데이터 관계

```text
Application (Project)
├── HealthCheckConfig (1:1)
├── Deployment (1:N, version 1, 2, 3...)
│   ├── PolicyResult (1:1)
│   └── StageExecution (1:N)
│       ├── DeploymentArtifact (1:N, 결과 원문)
│       └── DeploymentAuditLog (1:N, 감사 기록)
├── ApplicationAgent (N:M)
│   └── Agent
├── RoutingTarget (1:N)
│   └── RoutingTargetHealth (1:1)
└── ApplicationRoute (0:1)
    └── RoutingChange (1:N, audit log)
```

Health Check 설정은 Deployment마다 복사하지 않습니다. Application에 한 개를 둡니다.
따라서 새 Deployment도 현재 Application 설정을 사용합니다.

Agent token은 생성할 때 한 번만 반환합니다. DB에는 SHA-256 해시만 저장합니다.

User의 `id`는 내부 UUID입니다. `githubId`는 GitHub 숫자 ID이며 고유합니다. GitHub 로그인 이름이 바뀌어도 같은 사용자 ID를 사용합니다.

Deployment의 `requester`와 `approver`에는 인증한 User의 `id`를 저장합니다. Drizzle 관계는 `requesterUser`, `approverUser`입니다. 기존 문자열 기록을 보존하기 위해 DB 외래 키 제약은 추가하지 않았습니다. 이전 기록을 임의로 GitHub 계정에 연결하지 않습니다.

## 배포 단계

```text
test
  ↓
policy ── block → Deployment 종료
  ↓
needs_approval ── 승인 대기
  ↓
sign
  ↓
deploy
```

각 실행은 `attempt`, 시작·종료 시간, Exit Code, 산출물, 요약, 오류를 저장합니다.
재시도 기록은 이전 기록을 덮어쓰지 않습니다.

`STAGE_MODE=skeleton`은 내부 Stub을 사용합니다. 기본값입니다.

`STAGE_MODE=cli`는 기존 `policy/`와 `signer/` CLI를 호출합니다. CLI 모드는 각 폴더의 의존성을 먼저 설치해야 합니다.

## 결과 저장과 CLI 연결

영구 저장소는 DB입니다. 결과 파일 경로를 영구 저장소로 사용하지 않습니다.

- `deployment_artifacts`: JSON과 설명 문서의 원문, SHA-256 해시, 계약 스키마 이름, 검증 오류를 저장합니다.
- `deployment_audit_logs`: `decisions.jsonl`의 유효한 줄을 `deploy`, `rollback`, `sign`으로 구분하여 추가 저장합니다. 원본 JSONL도 산출물로 보관합니다.
- `policy_results`: 조회용 정책 요약과 `planArtifactId`, `piiArtifactId`를 저장합니다.
- 단계의 `artifacts` 값은 파일 경로가 아니라 DB 산출물 ID입니다.
- `GET /deployments/:id`는 `deployment`, `stages`, `policyResult`, `artifacts`, `auditLogs`를 반환합니다. 원문은 각 산출물의 `content`에 있습니다.

기존 CLI는 파일을 입력으로 받습니다. Worker는 실행마다 별도 임시 폴더를 만들고 DB 원문을 그대로 복원합니다. 단계가 끝나면 산출물, 감사 기록, 단계 상태를 한 DB 트랜잭션으로 저장합니다. 승인 대기 또는 실행 종료 후 임시 폴더를 삭제합니다. DB 저장이나 복원에 실패하면 복구용 임시 폴더를 남깁니다.

`WORK_DIR` 설정은 사용하지 않습니다. 임시 폴더 위치를 지정해야 할 때만 `CLI_TEMP_DIR`을 설정합니다. 기본값은 OS 임시 폴더 아래의 `hibiscus-cli`입니다. 임시 파일은 CLI 입력일 뿐 영구 저장소가 아닙니다.

공통 계약은 변경하지 않습니다. 외부 시스템의 응답은 정해진 TypeScript 계약 타입을 신뢰합니다. 서비스에서 DTO나 JSON Schema로 필드 타입·길이·추가 필드를 다시 검사하지 않습니다. 공개 스키마 검사는 테스트에서 수행합니다. 산출물의 `schemaName`은 계약 출처를 표시하는 메타데이터입니다. `deploy_result`의 공통 계약은 아직 없습니다.

결과 JSON을 다시 직렬화하지 않고 원문으로 저장합니다. 복원할 때 원문 해시를 확인합니다. 승인 계약의 `plan_sha256`은 별개입니다. 서명 CLI의 규칙대로 키를 정렬한 canonical JSON에서 계산합니다. `plan_hash`, 배열 순서와 계약 필드는 그대로 유지합니다.

JSON을 읽을 수 없거나 Deployment 식별 정보가 다르면 원문과 오류를 저장한 뒤 해당 단계를 실패로 처리합니다. 실패 결과는 다음 단계 입력으로 복원하지 않습니다. JWT 서명·만료·용도, OAuth state, 요청자·승인자, 배포 ID·digest·정책 해시의 일치 검사는 유지합니다. 관리 API 요청 DTO와 서버 시작 시 환경 설정 검증도 유지합니다.

기존 DB의 `workDir`, `planPath`, `piiPath` 열은 이전 기록을 보존하기 위해 남겨 둡니다. 새 배포에는 경로를 저장하지 않습니다. 이전 파일은 자동으로 DB에 이전하거나 삭제하지 않습니다.

## 실행

```bash
npm install
cp .env.example .env
# .env에 서로 다른 JWT 서명 키와 GitHub App 값을 설정
npm run start:dev
```

기본 주소는 `http://127.0.0.1:8080`입니다.

`JWT_ACCESS_SECRET`과 `JWT_REFRESH_SECRET`은 각각 최소 32자이며 서로 달라야 합니다. 각 키는 `openssl rand -hex 32`로 생성할 수 있습니다. GitHub App의 Client ID, Client Secret, `ALLOWED_GITHUB_IDS`도 필수입니다. 설정은 서버 시작 시 검증합니다. 필수 설정이 없거나 잘못되면 서버를 시작하지 않습니다. 서비스 안에서는 설정 누락을 다시 검사하지 않습니다.

백엔드 오류 메시지는 영문입니다. CLI의 원본 출력과 공통 계약의 정책 설명은 수정하지 않습니다. CLI 실패 시 원본 출력은 단계의 `summary.stdout`, `summary.stderr`에 보관하고 `error`에는 영문 오류를 저장합니다. 예상하지 못한 단계 오류의 원문은 `summary.details`에 보관합니다. Worker 자체 오류의 원문은 서버 로그에만 남깁니다.

## 인증과 사용자

사용자 로그인은 GitHub App 하나로 처리합니다. GitHub App의 OAuth Authorization Code + PKCE 흐름을 사용합니다. 별도 OAuth App은 만들지 않습니다. GitHub App 사용자 토큰은 OAuth scope를 사용하지 않으므로 로그인 URL에 `scope`를 넣지 않습니다. [GitHub App 사용자 로그인 문서](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

GitHub App 등록 방법:

- `Settings → Developer settings → GitHub Apps → New GitHub App`에서 등록합니다.
- Callback URL을 `http://localhost:8080/auth/github/callback`으로 설정합니다. 운영에서는 백엔드의 실제 HTTPS 주소를 사용합니다.
- `Request user authorization (OAuth) during installation`은 끕니다. 현재 서버는 `GET /auth/github`에서 생성한 state와 PKCE Cookie가 있어야 콜백을 처리합니다.
- 로그인만 쓰면 추가 권한이 필요하지 않습니다. 저장소와 브랜치를 조회하려면 Repository permissions의 **Contents: Read-only**를 설정합니다. Metadata는 기본 읽기 권한입니다.
- Webhook의 `Active`를 켜고 URL을 `https://<backend>/github/webhooks`로 설정합니다. Secret은 `GITHUB_WEBHOOK_SECRET`과 같은 값으로 설정합니다. **Push** 이벤트를 구독합니다. 필요한 저장소만 선택해 App을 설치합니다.
- 발급된 **Client ID**와 **Client Secret**을 `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`에 설정합니다. Client ID는 App ID와 다릅니다. 로그인에는 App ID와 Private Key를 사용하지 않습니다.

기존 `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` 설정은 사용하지 않습니다. GitHub App에서 발급한 값으로 아래 설정을 채우세요.

```dotenv
GITHUB_APP_CLIENT_ID=your-github-app-client-id
GITHUB_APP_CLIENT_SECRET=your-github-app-client-secret
GITHUB_APP_CALLBACK_URL=http://localhost:8080/auth/github/callback
ALLOWED_GITHUB_IDS=12345678,87654321
```

`ALLOWED_GITHUB_IDS`에는 로그인할 팀원의 GitHub 숫자 사용자 ID를 쉼표로 구분해서 넣습니다. OAuth Callback과 기존 JWT 검증에서 이 목록을 확인합니다. 목록에서 사용자를 제거하면 기존 Access·Refresh JWT도 더 이상 사용할 수 없습니다.

1. 같은 브라우저에서 `GET /auth/github`를 호출합니다. 서버가 `authorization_url`과 10분짜리 HttpOnly 임시 Cookie를 제공합니다.
2. 브라우저를 `authorization_url`로 이동합니다. `state`와 PKCE `S256`을 사용합니다. Cookie에는 서명한 state와 verifier를 보관합니다. 서버 세션은 저장하지 않습니다.
3. GitHub가 `GET /auth/github/callback?code=...&state=...`로 돌아옵니다. 서버가 Cookie와 state를 확인하고 code를 교환합니다.
4. 서버는 GitHub `/user`로 사용자를 확인한 뒤 Access JWT, Refresh JWT, 사용자 정보를 JSON으로 반환합니다. 콜백에서 추가 리다이렉트는 하지 않습니다.
5. 관리 API에 `Authorization: Bearer <access_token>`을 보냅니다. `GET /users/me`의 `id`가 배포·승인에 쓰는 identifier입니다.
6. `POST /auth/refresh`에 `{ "refresh_token": "..." }`를 보내 새 토큰을 받습니다.

GitHub App의 Callback URL과 `GITHUB_APP_CALLBACK_URL`을 같게 설정하세요. 기본값은 `http://localhost:8080/auth/github/callback`입니다. 시작 요청도 같은 호스트를 사용해야 Cookie가 콜백으로 전달됩니다. HTTPS Callback URL에서는 Cookie에 `Secure`를 설정합니다. 프론트엔드가 다른 Origin에서 호출하면 Cookie를 포함하도록 `credentials: 'include'`가 필요하며, 해당 Origin의 CORS 설정은 별도로 필요합니다.

Access JWT 기본 만료는 15분, Refresh JWT는 7일입니다. 각각 다른 서명 키와 audience로 검증합니다. Refresh JWT를 Access JWT로 사용할 수 없습니다. Refresh JWT는 서버에 저장하지 않습니다. 따라서 갱신 후에도 이전 Refresh JWT는 만료 전까지 유효합니다. 개별 토큰 즉시 폐기와 서버 Logout API는 제공하지 않습니다. 클라이언트는 Logout 시 보관한 토큰을 삭제합니다.

GitHub App 사용자 토큰과 GitHub refresh token은 AES-256-GCM으로 암호화해서 DB에 저장합니다. API 응답에는 반환하지 않습니다. 만료가 가까우면 GitHub refresh token으로 갱신합니다. `/auth/refresh`는 이와 별개로 Hibiscus JWT를 갱신합니다. GitHub 앱 연결의 브랜치 변경은 연결한 사용자만 할 수 있습니다. 기존 공통 관리 API 전체에 대한 프로젝트별 권한은 아직 제공하지 않습니다. Agent token과 사용자 JWT도 별도입니다.

### GitHub 저장소 연결과 Webhook

로그인 → 설치 목록 → 저장소 목록 → 브랜치 목록 → 앱 생성 순서로 호출합니다. Webhook 외에는 Bearer JWT가 필요합니다. 사용자가 접근할 수 있고 GitHub App도 설치된 저장소만 선택할 수 있습니다. [GitHub 설치 조회 API](https://docs.github.com/en/rest/apps/installations).

| API                                                         | 용도                                |
| ----------------------------------------------------------- | ----------------------------------- |
| `GET /github/connection`                                    | 연결 여부와 설치 URL                |
| `GET /github/installations`                                 | 계정이 접근할 수 있는 App 설치 목록 |
| `GET /github/repositories?installation_id=123`              | 설치별 저장소 목록                  |
| `GET /github/repositories/456/branches?installation_id=123` | 저장소 브랜치 목록                  |
| `POST /github/applications`                                 | 저장소와 브랜치로 앱 생성           |
| `PATCH /github/applications/:id/branch`                     | 연결한 사용자의 브랜치 변경         |
| `POST /github/webhooks`                                     | GitHub 이벤트 수신                  |

목록 API는 `page`, `per_page`를 받습니다. `per_page`는 최대 100입니다. 앱 생성 예:

```json
{
  "name": "My app",
  "slug": "my-app",
  "image_repo": "registry.example/my-app",
  "container_port": 8080,
  "installation_id": 123,
  "repository_id": 456,
  "branch": "main",
  "auto_deploy": true,
  "health_check": {
    "path": "/health",
    "version_path": "/version"
  }
}
```

실제 저장소와 브랜치 접근을 확인한 뒤 앱과 연결 정보를 함께 저장합니다. 브랜치 변경 본문은 `{ "branch": "develop", "auto_deploy": true }`입니다. `source_path`를 생략하면 저장소 URL을 저장합니다. **원격 저장소 checkout/build는 이 기능에 포함되지 않습니다.** 현재 로컬 실행이 필요한 경우 기존 파이프라인에 맞는 로컬 `source_path`를 지정해야 합니다. 프론트엔드 선택 화면도 별도입니다.

Webhook은 원본 요청 바이트의 HMAC-SHA256을 `X-Hub-Signature-256`과 상수 시간 비교합니다. [GitHub 서명 검증 문서](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

- 선택한 브랜치의 push만 기존 배포 큐에 넣습니다. trigger는 `webhook`, source revision은 push commit SHA이고 검증 상태는 `true`입니다.
- Delivery ID와 payload hash를 DB에 저장합니다. 같은 이벤트 재전송은 배포를 다시 생성하지 않습니다. 같은 ID에 다른 내용이면 409입니다.
- 수신 기록과 배포 생성은 한 DB 트랜잭션입니다. 실패하면 모두 취소합니다. 이후 재전송할 수 있습니다.
- 태그 push, 삭제 push, 선택하지 않은 브랜치는 배포하지 않습니다.
- App 설치 삭제·중단, 저장소 접근 제거, 사용자 인증 취소 이벤트는 해당 연결을 비활성화합니다. 인증 취소 시 GitHub 자격 증명도 삭제합니다.
- Webhook에는 빌드된 이미지 Digest가 없으므로 현재는 placeholder Digest를 저장합니다. 빌드 단계가 Registry Digest를 저장하기 전에는 실제 서명을 진행하지 않습니다.

`GITHUB_WEBHOOK_SECRET`은 최소 32자입니다. 없으면 Webhook은 503을 반환합니다. `GITHUB_APP_SLUG`는 설치 URL 생성용입니다. `GITHUB_TOKEN_ENCRYPTION_KEY`는 `openssl rand -hex 32`로 생성하고 운영에서 고정 보관하세요. 생략하면 JWT refresh 서명 키에서 별도 키를 파생합니다. 이때 JWT refresh 서명 키를 변경하면 GitHub 재로그인이 필요합니다. App private key와 installation token은 현재 방식에서 사용하지 않습니다.

배포 생성 본문은 다음과 같습니다. `requester`는 보내지 않습니다.

```json
{
  "source_revision": "0123456789abcdef",
  "image_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

승인은 `POST /deployments/:id/approve`에 빈 본문 `{}`를 보냅니다. `approver`는 보내지 않습니다. 본인 배포는 승인할 수 없습니다.

실제 서명은 검증된 Source Revision과 Registry Image Digest가 모두 있을 때만 진행합니다.

## API

- `GET /healthz`
- `GET /auth/github` (공개)
- `GET /auth/github/callback` (공개)
- `POST /auth/refresh` (공개, 유효한 Refresh JWT 필요)
- `GET /users/me`
- `POST /applications`
- `GET /applications`
- `GET /applications/:id`
- `PATCH /applications/:id/health-check`
- `POST /applications/:id/deployments`
- `GET /applications/:id/deployments`
- `GET /deployments/:id`
- `POST /deployments/:id/approve`
- `POST /agents`
- `GET /agents`
- `POST /applications/:id/agents/:agentId`
- `POST /applications/:id/targets`
- `GET /applications/:id/targets`
- `GET /applications/:id/routing`
- `PATCH /applications/:id/routing`
- `GET /agents/:id/tunnel`

`/agent/v1/*`는 Agent token이 필요합니다. `/healthz`와 인증 진입 API를 제외한 나머지 API는 Access JWT가 필요합니다. 두 인증 수단을 서로 바꾸어 사용할 수 없습니다.

## Routing과 SSH Reverse Tunnel

Routing Target은 특정 Deployment의 실행 위치입니다.

- `onprem`: 할당된 `agent_id`와 `local_port`를 사용합니다.
- `cloud_run`: HTTPS `url`을 사용합니다.
- 성공한 서명 결과가 있고 정책 `targets`가 허용한 종류만 Target으로 만들거나 현재 Route로 선택할 수 있습니다.
- `PATCH /applications/:id/routing`은 `target_id`, `expected_revision`, 선택 `reason`을 받습니다.
- Revision이 다르면 `409`를 반환합니다. 동시 변경으로 새 Route를 덮어쓰지 않습니다.
- Target Health는 `healthy`, `unhealthy`, `unknown`을 저장합니다. `expires_at`이 지나면 조회 결과는 `unknown`입니다.
- Health Monitor는 Application의 interval, timeout, success/failure threshold를 사용합니다.
- HTTP 상태 오류는 `application`, 연결·SSH·timeout 오류는 `network`로 저장합니다.
- 현재 On-Prem Target이 `unhealthy`이면 같은 Deployment의 정상 Cloud Run Target으로 전환합니다. 정책의 `failoverAllowed`가 `true`여야 합니다.
- SSH 연결 종료만으로 전환하지 않습니다. 자동 Failback도 하지 않습니다.

Application 생성 시 `slug`와 `GATEWAY_BASE_DOMAIN`으로 대표 주소를 만듭니다. `GATEWAY_BASE_DOMAIN=lth.so`, `slug=a`이면 `public_host`는 `a.lth.so`입니다. 요청 `Host`가 이 값과 일치하면 Gateway가 현재 Application Route로 전달합니다. `/_gateway/<slug>` 개발 경로는 사용하지 않습니다.

대표 주소는 Deployment 버전에 고정하지 않습니다. 새 Deployment의 Target이 준비되고 검증되면 조율기가 `PATCH /applications/:id/routing`을 호출합니다. 같은 `a.lth.so`가 새 Target을 가리킵니다. 새 Target 준비나 Route 변경이 실패하면 기존 Target을 유지합니다.

Gateway는 요청과 응답을 스트리밍합니다. Hop-by-hop 헤더는 전달하지 않습니다. 쓰기 요청도 자동 재전송하지 않습니다. `GATEWAY_IDLE_TIMEOUT_MS` 동안 데이터가 없으면 요청을 종료합니다.

Agent는 Backend API에서 전달 목록을 폴링합니다. 그 뒤 Backend의 `ssh2` Tunnel Server에 연결합니다. SSH 연결 하나에 여러 remote forward를 설정합니다.

```text
Gateway request
  ↓
VM 127.0.0.1:<gateway_port>
  ↓ SSH reverse forward
Agent 127.0.0.1:<local_port>
  ↓
Docker container
```

- Backend는 On-Prem Target 생성 시 `gateway_port`를 자동 할당합니다.
- Agent는 `GET /agent/v1/forwards`를 Agent token으로 폴링합니다.
- Agent는 자신이 관리하는 Docker host port만 전달합니다.
- SSH 연결이 끊기면 Agent가 다음 폴링에서 다시 연결합니다.
- Gateway와 Health Monitor는 `127.0.0.1:<gateway_port>`에 연결합니다.
- SSH 포트는 `SSH_FORWARD_PORT_MIN`부터 `SSH_FORWARD_PORT_MAX` 사이에서 할당합니다.
- `GET /agents/:id/tunnel`은 각 전달 포트의 접속 가능 상태를 반환합니다.
- Agent를 만들면 Agent token과 1회용 SSH 등록 token을 함께 발급합니다.
- Agent는 ED25519 키를 직접 생성하고 공개키만 Backend에 등록합니다.
- SSH 등록 token은 기본 10분 뒤 만료되며 한 번만 사용할 수 있습니다.
- Agent token을 폐기하면 등록한 SSH 공개키도 폐기합니다.
- Backend는 Agent 공개키를 DB에서 확인합니다.
- Backend는 해당 Agent에 할당된 `gateway_port`만 허용합니다.
- Backend는 SSH Shell, 명령 실행, SFTP, Agent의 임의 TCP 연결을 허용하지 않습니다.

Backend 프로세스가 SSH Tunnel Server를 직접 실행합니다. 시스템 `sshd`, OS Tunnel 사용자, `authorized_keys`, `AuthorizedKeysCommand`는 필요하지 않습니다.

```text
Agent ssh2 Client
  ↓ ED25519 공개키 인증
Backend ssh2 Tunnel Server :2222
  ↓ 허용된 127.0.0.1:<gateway_port>만 생성
Backend Gateway
```

`SSH_HOST_KEY_FILE`이 없으면 Backend가 ED25519 Host Key를 생성합니다. 이 파일을 영구 볼륨이나 Secret에 보관해야 합니다. 파일이 바뀌면 Agent의 Host Key 검증이 실패합니다. `SSH_HOST`는 Agent가 접속할 외부 주소입니다. `SSH_BIND_HOST`는 Backend의 수신 주소입니다. 기본 SSH 포트는 `2222`입니다. 운영 방화벽에서는 이 포트를 Agent 네트워크에만 엽니다.

## Agent API 계약 v1

기존 `deploy/mailbox/`의 Job·Result·Status 필드는 유지합니다. GCS 대신 Backend API와 DB를 사용합니다. 이 절은 API 전송 방식의 구현 계약입니다. 기존 조율기와 Agent 프로그램의 연결은 아직 필요합니다. 루트 `contracts/`와 기존 GCS 예시 파일은 수정하지 않았습니다.

`agent_id`는 Agent 등록 응답의 `agent.id`입니다. 기기 이름인 `name`과 다릅니다. 버전은 `schema_version: 1`입니다.

### 관리 API — 사용자 Access JWT

| Method | 경로                         | 기능                                  |
| ------ | ---------------------------- | ------------------------------------- |
| POST   | `/agents`                    | 등록·token 최초 발급                  |
| GET    | `/agents`, `/agents/:id`     | Agent 조회                            |
| POST   | `/agents/:id/token/rotate`   | 새 token 발급, 이전 token 즉시 무효화 |
| DELETE | `/agents/:id/token`          | token 폐기                            |
| POST   | `/agents/:id/ssh/enrollment` | 새 1회용 SSH 등록 token 발급          |
| GET    | `/agents/:id/status`         | 최근 상태 조회                        |
| POST   | `/agents/:id/jobs`           | 작업 생성                             |
| GET    | `/agents/:id/jobs`           | 작업 목록 조회                        |
| GET    | `/agents/:id/jobs/:jobId`    | 작업 상태와 결과 조회                 |

token 원문은 등록·교체 응답에서 한 번만 제공합니다. DB에는 SHA-256 해시만 저장합니다. 폐기된 Agent는 token 교체로 다시 등록 상태가 됩니다. Job·결과·heartbeat 기록은 삭제하지 않습니다.

`POST /agents`는 `ssh_enrollment_token`, 만료 시각, SSH host·port·user·host key 지문도 반환합니다. Agent는 최초 실행에서 다음 API를 한 번 호출합니다.

```http
POST /agent/v1/ssh/enroll
Authorization: Bearer <ssh_enrollment_token>
Content-Type: application/json

{"public_key":"ssh-ed25519 AAAA... hibiscus:<agent-id>"}
```

이 API에는 Agent token이 아니라 SSH 등록 token을 사용합니다. Backend는 ED25519 공개키만 받습니다. 개인 키는 받지 않습니다.

작업 생성 본문은 다음과 같습니다. `run_id`는 존재하는 Deployment ID여야 합니다. 해당 앱에 Agent가 할당되어 있어야 하며 `digest`는 Deployment의 값과 같아야 합니다.

```json
{
  "schema_version": 1,
  "job_id": "01234567-89ab-4def-8123-456789abcdef-candidate-01",
  "run_id": "01234567-89ab-4def-8123-456789abcdef",
  "action": "candidate",
  "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "image": "registry.example/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "plan_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "deadline": "2026-10-03T00:05:00.000Z"
}
```

- `action`: `candidate`, `activate`, `rollback`, `discard`.
- `candidate`: `image`와 `plan_hash`가 필요합니다. `image`의 digest는 Job의 값과 같아야 합니다.
- `rollback`: `to_digest`가 필요합니다.
- `created_at`은 선택입니다. 없으면 서버가 생성합니다. `deadline`은 필수이며 처음 생성할 때 미래 시각이어야 합니다.
- 같은 `job_id`와 같은 작업 내용으로 생성 요청을 반복하면 기존 작업을 반환합니다. 작업 내용이 다르면 `409`입니다.
- 관리 조회 응답은 `{ job, status }`입니다. 상세 조회에는 `results`도 포함합니다.

### 실행 API — Agent token

모든 호출에 `Authorization: Bearer <agent_token>`을 사용합니다.

| Method | 경로                           | 응답                                        |
| ------ | ------------------------------ | ------------------------------------------- |
| GET    | `/agent/v1/jobs/next`          | 작업 JSON `200`, 전달할 작업이 없으면 `204` |
| POST   | `/agent/v1/jobs/:jobId/result` | 저장한 Result JSON `200`                    |
| POST   | `/agent/v1/heartbeat`          | 저장한 상태 `200`                           |
| GET    | `/agent/v1/status`             | 자신의 최근 상태 `200`                      |
| GET    | `/agent/v1/forwards`           | SSH reverse forward 목록 `200`              |

폴링은 2초 간격을 권장합니다. Job은 `created_at` 순서로 Agent별 하나씩 전달합니다. 폴링 응답은 기존 Job 필드에 `schema_version`, `agent_id`, `attempt`, `lease_until`, `runtime`, `health_check`를 추가합니다. `runtime.container_port`는 Application 설정입니다. `health_check`는 Application의 현재 Health Check 설정입니다. 첫 전달은 `attempt: 1`입니다. 활성 lease가 있으면 추가 작업은 전달하지 않습니다.

```json
{
  "runtime": { "container_port": 8080 },
  "health_check": {
    "enabled": true,
    "path": "/health",
    "version_path": "/version",
    "method": "GET",
    "interval_seconds": 5,
    "timeout_seconds": 2,
    "success_status_min": 200,
    "success_status_max": 399,
    "success_threshold": 1,
    "failure_threshold": 3
  }
}
```

`version_path`는 선택 값입니다. 값이 있으면 Agent가 후보 Health Check 뒤 해당 경로를 `GET`으로 호출합니다. JSON 응답의 `run_id`가 Job의 `run_id`와 같아야 후보 배포가 성공합니다. 값이 없으면 기존 Health Check만 실행합니다.

lease 기본값은 candidate 120초, 나머지 작업 30초입니다. `AGENT_CANDIDATE_LEASE_MS`, `AGENT_ACTION_LEASE_MS`로 서버 시작 전에 설정합니다. `lease_until`은 `deadline`을 넘지 않습니다. lease 만료 후 재전달할 때는 같은 `job_id`에서 `attempt`를 올립니다. deadline이 지난 작업은 `expired`로 종료합니다.

결과 제출 예시:

```json
{
  "schema_version": 1,
  "agent_id": "b1234567-89ab-4def-8123-456789abcdef",
  "job_id": "01234567-89ab-4def-8123-456789abcdef-candidate-01",
  "run_id": "01234567-89ab-4def-8123-456789abcdef",
  "action": "candidate",
  "attempt": 1,
  "result": "ok",
  "candidate": {
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "container": "demo-candidate-01",
    "url": "http://127.0.0.1:18081"
  },
  "check": { "mode": "candidate", "pass": true, "checks": [] },
  "finished_at": "2026-10-03T00:01:00.000Z"
}
```

- 공통 필수 필드: `schema_version`, `agent_id`, `job_id`, `run_id`, `action`, `attempt`, `result`, `finished_at`.
- 실패 결과는 `result: "error"`와 `error`를 보냅니다.
- 성공한 candidate의 `candidate.digest`는 Job과 같아야 합니다.
- 성공한 activate·rollback에는 `serving`을 보냅니다. digest는 각각 Job의 `digest`, `to_digest`와 같아야 합니다. `previous`는 기존 컨테이너 기록을 그대로 보관합니다.
- `check`, `candidate`, `previous`, `serving`의 알려진 내부 타입은 신뢰합니다. 중복 DTO·스키마 검사를 하지 않습니다.
- 현재 attempt와 유효한 lease의 결과만 받습니다. 다른 Agent의 작업은 `404`, 실행 정보 불일치·늦은 결과는 `409`입니다.
- 같은 attempt의 동일 결과 재전송은 `200`입니다. 다른 내용으로 덮어쓰려 하면 `409`입니다. 완료된 결과는 deadline 이후에도 동일하게 재전송할 수 있습니다.
- `ok` 결과는 `succeeded`, `error` 결과는 `failed`로 종료합니다. 종료된 작업을 다시 실행하려면 새로운 `job_id`로 생성합니다.

lease는 중복 전달과 늦은 결과 수락을 제어합니다. `onprem-agent`는 `job_id`별 실행 결과를 상태 파일에 저장합니다. lease 만료 후 같은 Job이 새 attempt로 재전달되면 Docker 작업을 반복하지 않고 저장한 결과의 attempt만 바꿔 전송합니다.

heartbeat는 `schema_version`, `agent_id`, `updated_at`, `serving`을 보냅니다. `public_url`은 선택입니다. 실행 중인 컨테이너가 없으면 `serving: null`입니다. 컨테이너 정보는 `{ run_id, digest, container }`입니다. 오래된 heartbeat로 최신 상태를 덮어쓰려 하면 `409`입니다.

`online`·`offline`은 서버의 마지막 Agent 인증 요청 수신 시각으로 판단합니다. 기본 기준은 30초이며 `AGENT_OFFLINE_AFTER_MS`로 설정합니다. Agent가 보낸 미래 시각으로 online 시간을 늘릴 수 없습니다. 이 상태는 Agent 연결 상태이며 앱 Health 판정이나 Failover 정책이 아닙니다.

`agent_jobs`, `agent_job_results`, `agent_heartbeats`는 Drizzle DB에 저장합니다. 서버 재시작 후에도 token, 실행 attempt, lease, 결과, 최근 상태를 유지합니다. Docker 실행은 별도 `onprem-agent`가 담당합니다. 배포 조율기가 Job을 자동 생성하고 결과를 기다리는 연결은 아직 없습니다.

## 데이터베이스

```bash
# 스키마 변경 후 마이그레이션 생성
npm run db:generate

# 마이그레이션 적용
npm run db:migrate
```

서버도 시작할 때 마이그레이션을 적용합니다.

## 검증

```bash
npm run build
npm run lint
npm run test
npm run test:e2e
```

E2E 테스트는 임시 SQLite DB를 사용합니다. 테스트가 끝나면 임시 DB를 삭제합니다.
GitHub 응답은 테스트에서 대체합니다. scope 없는 GitHub App 로그인 URL, App Client ID의 코드 교환, 만료·갱신 정보가 포함된 GitHub App 사용자 토큰 응답, PKCE, Cookie/state 검증, JWT 만료·변조·용도 분리, 사용자 ID 유지, 요청자·승인자 위조와 본인 승인 거부를 확인합니다. 실제 GitHub 로그인은 GitHub App 설정 후 별도로 확인해야 합니다.

DB 결과 저장, 잘못된 결과의 차단, 원문 해시와 경로 검사, 트랜잭션 롤백, 서버 재시작 후 승인 재개도 확인합니다. `policy/`와 `signer/`의 의존성이 있으면 실제 정책 CLI와 dry-run 서명 CLI의 자동·승인 배포도 확인합니다. 의존성이 없으면 이 CLI 테스트만 건너뜁니다. 외부 레지스트리 서명과 실제 배포는 이 테스트에 포함하지 않습니다.

## 다음 구현 범위

- 실제 테스트 실행기
- 운영 정책 설정과 실제 이미지 서명 검증
- Cloud Run 후보 배포, 트래픽 전환, 롤백
- 배포 조율기와 Agent Job 자동 연결
- 앱 오류와 네트워크 오류의 구조화된 구분
- 운영 도메인 DNS와 TLS 인증서 연결
