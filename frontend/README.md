# frontend

데모용 화면. 배포 한 건의 근거(테스트 → 정책 → 승인 → 서명 → 배포)와 앱의 현재 트래픽 위치를 보여 줌

- Vite + React + TypeScript, 의존성은 react / react-dom 만
- 백엔드는 `backend-v2` 기준
- 해시 라우팅 (`#/applications/:id`, `#/deployments/:id`)

## 실행

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

### MOCK 모드 (백엔드 없이)

- 토큰이 없으면 자동으로 MOCK
- `?mock=1` 을 붙이거나 상단 토글로도 전환 (`?mock=0` 은 강제 해제)
- 화면 상단에 `MOCK` 표시와 안내 줄이 항상 보임. 데이터는 시연용
- 데이터 위치: `src/mocks/`
  - `data/guestbook-v3.test_result.json` ← `parity/examples/premortem_integration_result.json` 의 조건별 결과를 TestResult 계약 형태로 변환
  - `data/guestbook-v3.plan.json` ← `signer/fixtures/plans/block.plan.json` + `policy/policy.yaml` 의 R1b·R5·R6
  - `data/guestbook-v1.deploy_result.json` ← `deploy/examples/deploy_result.json` 을 backend-v2 `DeployResult` 형태로
  - 원본 파일은 수정하지 않음

시나리오

| 화면 | 내용 |
|---|---|
| guestbook v3 | 정책 차단. requires `fix_restart_failure`·`managed_db`·`object_storage`, 조건별 none 20/20 · restart 14/20 · replace 13/20. 커밋 검증(true)과 차단이 같이 있음 |
| guestbook v1 | 허용 → 배포 완료, 트래픽 전환 (activated + routing ok). On-Prem 활성, Cloud Run 대기 |
| guestbook v2 | 후보 검사 실패 → held, 기존 서비스 유지 |
| guestbook 앱 화면 | `On-Prem 장애 재현` 버튼 → 연속 실패 3회 뒤 unhealthy → Cloud Run 으로 failover (rev 1 → 2), 배너 표시 |
| contacts v1 | 개인정보 후보로 승인 대기. `승인` → 서명 → 배포 진행이 2초 폴링으로 보임. 승인 전에는 앱 경로 없음 |

- MOCK 사용자는 `Seungpyo1007`. contacts v1 은 다른 사람이 요청한 배포라 승인 가능
- `초기화` 버튼 또는 새로고침으로 처음 상태로

### 백엔드 연결

```bash
# backend-v2 기본 주소 http://127.0.0.1:8080
VITE_API_TARGET=http://localhost:8080 npm run dev
```

- 백엔드에 CORS 가 없어서 Vite 프록시 사용: 브라우저 → `/api/*` → `VITE_API_TARGET/*` (`/api` 는 떼고 전달)
- `npm run preview` (빌드 결과 확인) 도 같은 프록시 사용
- 토큰 받기
  1. 브라우저에서 백엔드 주소로 직접 `GET /auth/github` 열기 (예: `http://localhost:8080/auth/github`). 프록시를 거치면 state Cookie 경로가 달라서 콜백이 실패함
  2. 응답의 `authorization_url` 로 이동해 GitHub 로그인
  3. 콜백 화면의 JSON 전체 복사
- 화면 상단 `연결` → JSON 전체 붙여넣기 (또는 access_token, refresh_token 따로) → `연결`
- 토큰은 localStorage 에 저장. 401 이면 `POST /auth/refresh` 를 한 번 부르고 재시도, 그래도 401 이면 다시 붙여넣기
- `토큰 지우고 MOCK으로` 로 해제

## 화면

- 앱 목록: 앱마다 현재 경로(On-Prem / Cloud Run, revision)
- 배포 상세 (`#/deployments/:id`)
  - 단계 표시: 테스트 → 정책 → 승인 → 서명 → 배포
  - 실행 정보: 커밋 7자리 + `테스트한 이미지 = 이 커밋` (sourceRevisionVerified), digest 12자리 + registry/placeholder, 실제 배포 여부, 요청자·승인자
  - 테스트: 통과 여부, 조건별 막대(none / restart / replace), 어긋난 요청
  - 정책: decision, 배포 위치, failover, 고쳐야 할 것(requires), 걸린 규칙과 이유(일본어 있으면 같이), plan_hash
  - 승인: 대기 중이면 버튼. 요청자 본인은 비활성 (서버도 403)
  - 서명: signature_ref (`dry-run:` / `cosign:` 구분), 시각. 거부되면 sign_result 가 없어서 감사 기록(kind `sign`)의 reason 표시
  - 배포: deploy_result 의 `decision` 과 `routing.result` 를 따로 읽어 표시
  - 결정 기록, 산출물 원문
  - 진행 중(queued / running)일 때만 2초 폴링
- 앱 상세 (`#/applications/:id`)
  - 현재 트래픽 위치, route revision, 대기 대상(같은 배포의 다른 enabled 대상), failover 허용 여부(현재 경로 배포의 정책 결과)
  - 대상별 health (healthy / unhealthy / unknown), 실패 종류(application / network), 이유, 연속 실패 수
  - Agent 상태, 마지막 연결, 서빙 중인 버전
  - 배포 기록 (version 내림차순)
  - 4초 폴링. revision 이 바뀌면 배너 (`failover 발생` 또는 `트래픽 경로 바뀜`)

배포 결과 표시 기준

| decision | routing.result | 표시 |
|---|---|---|
| activated | ok | 배포 완료, 트래픽 전환됨 |
| activated | error / skipped | 새 버전은 떴지만 트래픽 전환 실패 (경고, 성공 아님) |
| held | skipped | 후보 검사 실패, 기존 서비스 유지 |
| rolled_back | skipped | 전환 중 실패, 이전 버전으로 복구 |
| rolled_back | error | 트래픽 전환 실패, 이전 버전으로 복구 (#26) |
| error | skipped / error | 배포 오류. rollback 단계가 실패했으면 `Cloud Run이 새 버전을 서빙 중일 수 있음` |
| (결과 없음) | - | 단계 skipped → 배포 생략, 단계 failed → 배포 시작 안 됨(사전 검사 실패), 단계 없음 → 시작 안 됨 |

- #26 이후 `activated + error` 는 백엔드가 만들지 않음. 예전 기록이나 다른 경로 대비로만 남김
- `deploymentPerformed` 가 false 면 어디에도 `배포됨` 으로 표시하지 않음

## 검사

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (배포 결과 판정, 최신 시도 고르기, 산출물 읽기, failover 감지, 토큰 붙여넣기)
npm run build
```

## 한계

- failover 이력 API 가 없어서 화면을 열어 둔 동안 본 revision 변화만 배너로 표시. 새로고침하면 사라짐
- 다른 사용자 login 을 찾는 API 가 없어서 요청자·승인자는 User id 앞 8자리 (본인만 `나 (login)`)
- `GET /applications/:id` 의 `agents[].status` 는 DB 값 그대로라 online/offline 계산은 `GET /agents/:id/status` 결과를 씀
- 배포 생성, 앱 등록, Agent 할당, 수동 경로 변경 화면은 없음
- 로그인 리다이렉트 없음 (토큰 붙여넣기만)
- 실시간 연결 없음 (폴링)
