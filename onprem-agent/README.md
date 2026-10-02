# Hibiscus On-Prem Agent

Backend 작업을 폴링하고 Docker 컨테이너를 관리합니다. Backend VM으로 outbound SSH Reverse Tunnel도 연결합니다.

## 처리 흐름

```text
Backend Job polling
  ↓
candidate: cosign verify → docker pull/run → Health Check
  ↓
activate: 새 컨테이너를 serving으로 기록
  ↓
rollback 또는 discard
  ↓
Result + heartbeat 전송
```

- Job은 `created_at` 순서로 하나씩 처리합니다.
- `job_id`별 결과를 상태 파일에 저장합니다. 같은 Job을 다시 받으면 Docker 작업을 반복하지 않고 저장한 결과를 다시 전송합니다.
- 컨테이너 이름은 `hibiscus-<run_id>-<digest 12자리>` 형식입니다.
- Docker host port는 자동 할당합니다. `127.0.0.1`에만 바인딩합니다.
- Application의 `container_port`와 Health Check 설정은 Backend Job 응답에서 받습니다.
- `version_path`가 있으면 Health 성공 뒤 JSON `run_id`가 현재 Job과 같은지 확인합니다.
- `activate`는 serving 상태를 확정합니다. 실제 외부 트래픽은 Backend Application Route가 전환합니다.
- 이전 컨테이너는 즉시 삭제하지 않습니다. `rollback` 또는 `discard` Job으로 처리합니다.
- SSH Tunnel은 Agent 상태에 등록된 Hibiscus 관리 컨테이너의 host port에만 연결합니다. Backend가 다른 loopback port를 요청하면 거부합니다.

## 실행

필수 프로그램:

- Node.js
- Docker
- cosign

```bash
npm install
npm run build
cp .env.example .env

set -a
source .env
set +a
node dist/main.js
```

## 설정

| 키                                  |                     기본값 | 기능                                    |
| ----------------------------------- | -------------------------: | --------------------------------------- |
| `BACKEND_API_URL`                   |                       필수 | Backend HTTP API 주소                   |
| `AGENT_ID`                          |                       필수 | Agent 등록 응답의 `agent.id`            |
| `AGENT_TOKEN`                       |                       필수 | Agent 등록 또는 token 교체 응답의 token |
| `SSH_ENROLLMENT_TOKEN`              |                  최초 필수 | 1회용 SSH 공개키 등록 token             |
| `COSIGN_PUBLIC_KEY`                 |                       필수 | 이미지 서명 공개키 경로                 |
| `AGENT_STATE_FILE`                  |  `./data/agent-state.json` | 컨테이너와 완료 Job 상태 파일           |
| `AGENT_POLL_INTERVAL_MS`            |                     `2000` | Job 폴링 간격                           |
| `AGENT_HEARTBEAT_INTERVAL_MS`       |                    `10000` | heartbeat 전송 간격                     |
| `BACKEND_REQUEST_TIMEOUT_MS`        |                    `10000` | Backend API 요청 시간 초과              |
| `COMMAND_TIMEOUT_MS`                |                   `100000` | Docker·cosign 명령 시간 초과            |
| `DOCKER_STOP_TIMEOUT_SECONDS`       |                       `10` | 컨테이너 정지 대기 시간                 |
| `COSIGN_ALLOW_INSECURE_REGISTRY`    |                    `false` | 로컬 개발용 HTTP Registry 허용          |
| `COSIGN_INSECURE_IGNORE_TLOG`       |                    `false` | 로컬 테스트에서만 transparency log 생략 |
| `SSH_HOST`                          |                  자동 설정 | Backend VM SSH 주소                     |
| `SSH_PORT`                          |                     `2222` | Backend Tunnel Server 포트              |
| `SSH_USER`                          |                  자동 설정 | Tunnel 인증 사용자 이름                 |
| `SSH_IDENTITY_FILE`                 | `./data/ssh/agent_ed25519` | Agent 전용 SSH 개인 키 경로             |
| `SSH_HOST_KEY_SHA256`               |                  자동 설정 | 고정한 VM SSH host key 지문             |
| `SSH_READY_TIMEOUT_MS`              |                    `10000` | SSH 연결 준비 시간 초과                 |
| `SSH_FORWARD_POLL_INTERVAL_MS`      |                     `2000` | 전달 목록 확인 간격                     |
| `SSH_SERVER_ALIVE_INTERVAL_SECONDS` |                       `15` | SSH keepalive 간격                      |
| `SSH_SERVER_ALIVE_COUNT_MAX`        |                        `3` | 연결 종료 전 keepalive 실패 횟수        |
| `SSH_SESSION_MAX_MS`                |                   `900000` | 공개키 재검사를 위한 최대 연결 시간     |

SSH Tunnel의 Agent와 Backend는 모두 `ssh2` Node 모듈을 사용합니다. 시스템 `ssh`, 시스템 `sshd`, `child_process`를 사용하지 않습니다. SSH 연결 하나가 여러 앱의 TCP 연결을 함께 처리합니다. 전달 목록이 바뀌거나 최대 연결 시간이 지나면 연결을 다시 구성합니다.

최초 실행 흐름:

```text
POST /agents 응답을 Agent 환경 변수에 설정
  ↓
Agent가 ED25519 개인 키와 공개키 생성
  ↓
공개키만 POST /agent/v1/ssh/enroll로 전송
  ↓
등록 완료 파일 저장
  ↓
ssh2 연결 시작
```

개인 키는 `SSH_IDENTITY_FILE`에 mode `0600`으로 저장합니다. 공개키와 등록 완료 정보는 같은 경로에 `.pub`, `.enrolled` 접미사로 저장합니다. 같은 등록 token으로 다시 실행해도 공개키 등록을 반복하지 않습니다. 키를 교체할 때는 관리 API에서 새 SSH 등록 token을 발급하고 Agent 설정을 교체합니다.

`candidate`는 다음 서명을 확인합니다.

```bash
cosign verify \
  --key "$COSIGN_PUBLIC_KEY" \
  -a "run_id=<run_id>" \
  -a "plan_hash=<plan_hash>" \
  "<image>@<digest>"
```

운영에서는 `COSIGN_ALLOW_INSECURE_REGISTRY`와 `COSIGN_INSECURE_IGNORE_TLOG`를 `false`로 유지합니다.

## 상태 복구

Agent는 상태 파일을 원자적으로 교체합니다. 재시작할 때 다음 작업을 수행합니다.

1. 저장된 컨테이너가 Hibiscus 관리 컨테이너인지 확인합니다.
2. 삭제된 컨테이너 기록을 제거합니다.
3. serving 컨테이너가 정지되어 있으면 다시 시작합니다.
4. 완료한 `job_id`의 결과를 유지합니다.

## 검증

```bash
npm run build
npm run lint
npm test
```

단위 테스트는 실제 Docker를 실행하지 않습니다. Docker 명령 계약과 Job 상태 전환을 가짜 실행기로 검사합니다.

실제 Docker·cosign lifecycle은 서명된 이미지 2개로 확인합니다.

```bash
SMOKE_IMAGE_A="registry.example/app@sha256:..." \
SMOKE_IMAGE_B="registry.example/app@sha256:..." \
SMOKE_COSIGN_PUBLIC_KEY="./cosign.pub" \
SMOKE_STATE_FILE="/tmp/hibiscus-smoke-state.json" \
SMOKE_RUN_PREFIX="hibiscus-smoke" \
SMOKE_PLAN_HASH="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" \
npm run smoke
```

두 이미지는 각각 `<SMOKE_RUN_PREFIX>-a`, `<SMOKE_RUN_PREFIX>-b`의 `run_id`와 `SMOKE_PLAN_HASH` annotation으로 서명되어 있어야 합니다. 테스트는 candidate A → activate A → candidate B → activate B → rollback A → discard B 순서로 실행합니다. 테스트 컨테이너는 종료 시 정리합니다.
