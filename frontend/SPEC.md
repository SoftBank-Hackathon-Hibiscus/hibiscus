# 데모 프론트 화면 명세

기준: main `2cca2c3` (#26 deploy stage 머지 완료, #21 registry build 머지 완료). 2026-10-03.

아직 머지되지 않은 것: PR #29 `c68b94d` (registry parity 연결, Draft), PR #33 `35644ec` (sourceRevisionVerified 의미 정리, Open). 둘 다 API 경로를 바꾸지 않고 `GET /deployments/:id` 가 돌려주는 데이터만 달라진다.

실제 팀 backend-v2 와의 real mode 연결은 아직 검증하지 않았다. 이 문서의 real mode 내용은 main 소스 코드를 읽고 맞춘 것이다.

## 0. 화면 구성

| 화면 | 경로 | 내용 |
|---|---|---|
| Demo Launcher | `/` (mock) | mock 시나리오 4개를 고르는 시작판. 앱 관리 기능은 없다 |
| Deployment Detail | `#/deployments/<id>` | 왼쪽 단계 카드 4개(테스트·정책·서명·배포), 오른쪽 선택한 단계의 상세 + 증명 체인, 맨 아래 "세부 기술 정보" 접힘 |
| Application Detail | `#/applications/<id>` | 요약 카드 4개(트래픽 위치·상태·장애 시 자동 전환·전환 횟수), On-Prem / Cloud Run 카드, 배포 이력 |
| real 연결 | `/?mode=real` | 백엔드 → 토큰 → 앱 선택 체크리스트 |

- 모드는 `?mode=mock&scenario=N` / `?mode=real`. mock 이면 상단에 DEMO DATA 배지가 항상 보인다.
- KO / JA 전환(상단 바, 정책 설명 모달 안). 선택한 언어 하나만 보여주고 데이터의 `reason_i18n.ja`, `hint_i18n.ja`, `explain.ja` 도 같은 선택을 따른다.
- 문구는 3단계: 결론 한 문장 → 쉬운 이유 1~3개 → "세부 기술 정보"(run_id·digest·plan_hash·규칙 ID·requires id·exit code·실행 모드·원본 JSON)는 접힘 안에서만.

## 1. API (main 기준)

인증은 전역 가드. `Authorization: Bearer <access JWT>`. 응답은 Drizzle row 그대로(camelCase), Agent 상태 응답만 snake_case. 전역 prefix 없음.

| Method | Path | 응답 주요 필드 | 비고 |
|---|---|---|---|
| GET | `/healthz` | `{ok:true}` | 공개. 프론트는 body 까지 확인한다 (다른 서버가 8080 을 써도 초록이 되지 않게) |
| GET | `/auth/github` | `{authorization_url}` + HttpOnly 쿠키(path `/auth/github`, 10분) | 공개 |
| GET | `/auth/github/callback` | JSON `{access_token, refresh_token, expires_in, user}` | 공개. 리다이렉트 없음 |
| GET | `/users/me` | `{id, githubId, login, ...}` | 연결 상태 초록의 유일한 기준 |
| GET | `/applications` | `ApplicationView[]` | real 체크리스트의 앱 목록 |
| GET | `/applications/:id` | `{application, healthCheck, agents[{id,name,status,lastSeenAt}]}` | agents[].status 는 DB 값 |
| GET | `/applications/:id/deployments` | `Deployment[]` version 내림차순 | |
| GET | `/deployments/:id` | `{deployment, stages[], policyResult, artifacts[](content 포함), auditLogs[]}` | |
| POST | `/deployments/:id/approve` | body `{}` → Deployment | 본인 승인 403, 대기 아님 409 |
| GET | `/applications/:id/targets` | `[{target, health\|null}]` | |
| GET | `/applications/:id/routing` | `{applicationId, target, revision, health}` | 첫 PATCH 전 404 |
| GET | `/agents/:id/status` | `{agent_id, status, last_seen_at, updated_at, received_at, serving, public_url}` | online/offline 계산값 |

main 에 없는 것: CORS 설정, 정적 파일 서빙, routing 변경 이력 조회 API(`routing_changes` 테이블은 있고 insert 만 함), 콜백 리다이렉트, dev 토큰. 모두 프론트에서 우회한다 (Vite 프록시, vite preview, 클라이언트 diff, 토큰 붙여넣기).

## 2. Deployment Detail

출처는 모두 `GET /deployments/:id` 한 번. 앱 이름만 `GET /applications/:id`. `stages` 는 attempt 별 row 가 쌓이므로 **단계별 최대 attempt 만** 표시. 판정은 `src/lib/summary.ts` 한 곳에서 한다.

### 첫 화면

- 제목(앱 이름 v버전) + 결론 한 문장 + 결정 배지(ALLOW / NEEDS_APPROVAL / BLOCK) + 상태 배지.
- 왼쪽 단계 카드: 아이콘, 한 줄 결과(이유 포함), 소요 시간. 실행 안 된 단계는 "정책에서 막혀 진행하지 않았어요" / "앞 단계에서 멈춰 진행하지 않았어요". 기본 선택은 결론과 관련된 단계(block → 정책, held/rolled_back/error → 배포, 그 외 → 정책).
- 오른쪽 상세
  - 정책: 결정 크게, 배포 가능한 위치, 장애 시 자동 전환(함/안 함 + 이유), "왜 이런 결정인가요"(조건별 불일치 수, SQLite·로컬 파일 사실), 고칠 것 카드(할 일 / 이유 / "고치면 배포 가능: allowed_targets"), 개인정보 후보(있을 때만), "정책 설명 보기" 버튼, 세부 기술 정보.
  - 테스트: none/restart/replace 막대, 어긋난 요청 접기, 세부 기술 정보.
  - 서명·배포: 핵심 값만, 나머지는 세부 기술 정보.
- 증명 체인 4줄(같은 배포 요청 / 같은 코드 / 같은 이미지 / 같은 결정). 값은 "세부 기술 정보"를 눌렀을 때만.
- 맨 아래 "세부 기술 정보" 접힘: 실행 식별자, 정책 규칙 ID·plan hash, 감사 기록, 원본 산출물 JSON.

### 정책 설명 모달

- "정책 설명 보기" → `document.body` 에 포털로 띄우는 가운데 모달. 제목은 `앱 v버전 · 정책 결정`, 본문은 현재 언어의 `explain.ko` / `explain.ja` 마크다운. 모달 안 KO/JA 전환, 닫기는 X·바깥 클릭·Esc, 열려 있는 동안 html/body 스크롤 잠금.
- 본문에서 제목의 "(실행 run_id)"와 문장 끝의 규칙 ID "(R1b)" 를 떼고, 마지막 `---` 아래(결정 지문·이미지·커밋)는 "세부 기술 정보"로 보낸다.
- explain 산출물이 없으면(skeleton 모드) 버튼을 숨긴다.

### 데이터 출처

| 섹션 | 필드 | 출처 |
|---|---|---|
| 상단 | version, status, decision, deploymentPerformed, sourceRevisionVerified, error | `deployment` |
| 식별자(세부 기술 정보) | run_id(id), 커밋(sourceRevision), digest, digestSource, trigger, executionMode, requester, approver, created/updated | `deployment` |
| 테스트 | stage status·summary(`{stub, test_passed}` 또는 `{template, stub:true}`), passed, match, failures, `facts.conditions[]`(있으면 막대), facts.db, writes_local_file, migration | `stages[test]` + `artifacts[name=test_result]` |
| 정책 | decision, targets, failoverAllowed, requires[{id, hint, hint_i18n.ja, rule_id, allowed_targets}], rules 중 matched/matched_after_block 의 reason(+ja), explain.ko/ja 원문, pii 표, planHash | `policyResult` + `artifacts[name=plan, pii, explain.ko, explain.ja]` |
| 승인 | needs_approval 이면 정책 상세 안에 카드. awaiting_approval 이면 승인 버튼, approver, approval 산출물(approved_at, plan_sha256) | `deployment` + `artifacts[name=approval]` |
| 서명 | SignLog result(signed/refused)+reason, signature_ref(`dry-run:` 이면 모의 서명), signed_at, requester/approver, targets, failover | `stages[sign]` + `artifacts[name=sign_result]` + `auditLogs[kind=sign]` |
| 배포 | 아래 상태 조합 표 | `stages[deploy]` + `artifacts[name=deploy_result]` |
| 감사 기록 | kind, time, decision/result, rule_ids, plan_hash | `auditLogs[]` |
| 산출물 | 단계별 전체 목록, JSON 은 pretty, text 는 원문 | `artifacts[]` |

### 표시 규칙

- `decision` 과 `routing.result` 는 **별도로 읽는다**. 최신 main(`882d4a7`)은 대표 경로 변경이 실패하면 activated 로 남기지 않고, 전환한 대상을 모두 되돌리면 `rolled_back`, 하나라도 못 되돌리면 `error` 로 기록한다 (`routing.result=error`, `deploymentPerformed=false`). 프론트는 이 두 경우에 "트래픽을 넘기지 못해 되돌렸어요" / "일부 대상을 되돌리지 못했어요"와 대상별 rollback 결과를 보여준다.
- activated + routing.result=error 조합은 최신 main 에서는 만들어지지 않는다. 프론트의 해당 분기(빨강 "새 버전은 떴지만 트래픽 전환 실패")는 구 버전 결과를 위한 **방어용 fallback** 이며 정상 상태가 아니다.
- `deploymentPerformed=false` 면 "배포됨" 이라 쓰지 않는다.
- `sourceRevisionVerified` 는 증명 체인 "같은 코드"로 보여준다. 의미(#33 + #29, 미머지): 생성 시 manual·webhook 모두 false, registry parity 검증 뒤 true. 테스트가 block 이어도 true 일 수 있다. **현재 main 은 #33 이 없어 GitHub push 요청이면 재생 테스트 없이도 true 를 기록한다.** 그래서 테스트 단계가 stub(`summary.stub=true`)이면 ✓ 대신 "확인 전"으로 두고 이유를 적는다.
- 산출물은 `name` 으로 고른다. 같은 이름이 두 단계에 있으면(test_result 는 test·policy 둘 다) 해당 단계의 것을 우선. `mediaType=application/json` 만 parse, 실패하면 원문 fallback. `explain.ko`·`explain.ja`(text/plain) 는 parse 하지 않는다.
- `executionMode=skeleton` 이면 규칙 이유·설명 문서·개인정보 판정이 없다(plan.rules 는 `[{id:'skeleton'}]`, requires 는 id 만). 그 사실을 한 줄로 알리고 해당 칸을 숨긴다. `facts.conditions` 가 없으면 조건별 막대를 숨긴다.
- 폴링: status 가 queued/running/awaiting_approval 일 때만 2초.

### 증명 체인 문구 (진행 범위별)

| 줄 | BLOCK | HELD / ROLLED_BACK | ALLOW + 배포 완료 |
|---|---|---|---|
| 같은 배포 요청 | 테스트와 정책 판단이 하나의 실행으로 이어졌어요 | 테스트부터 배포까지 하나의 실행으로 이어졌어요 | 같음 |
| 같은 코드 | 이 커밋에서 만든 이미지인지 확인했어요 (verified) / 확인 전 (stub) / 미확인 | 같음 | 같음 |
| 같은 이미지 | 테스트와 정책 판단이 같은 이미지를 기준으로 했어요 | 서명까지 같은 이미지를 기준으로 했어요 | 테스트한 이미지 그대로 서명하고 배포했어요 |
| 같은 결정 | 해당 없음: 정책에서 차단되어 서명과 배포로 진행하지 않았어요 | 정책 결정 그대로 서명했지만, 새 버전이 검사를 통과하지 못해 트래픽을 옮기지 않았어요 | 정책이 허용한 위치와 장애 전환 설정 그대로 배포했어요 |

값이 2개 이상 있고 모두 같을 때만 ✓, 다르면 "불일치", 비교할 값이 부족하면 "확인 전"과 이유. plan_hash 는 정책↔서명만 직접 비교하고, deploy_result 에는 plan_hash 가 없어 cosign 서명 검증 기록으로 간접 확인한다. 임의로 성공 처리하지 않는다. mock 에서는 DEMO DATA 배지를 같이 둔다.

### deploy_result 상태 조합 (main `deploy-result.type.ts`)

`routing.result` 는 decision 이 activated 일 때 ok, 대표 경로 변경이 실패해 되돌린 경우 rolled_back/error 와 함께 error, 그 외 skipped.

| decision | routing.result | 백엔드 기록 | 화면 |
|---|---|---|---|
| activated | ok | stage succeeded, performed=true | "트래픽을 옮겼어요", {위치}에서 새 버전이 트래픽을 받음, standby 안내 |
| rolled_back | error | stage failed(exit 4), performed=false | 주황 "새 버전은 떴지만 트래픽을 넘기지 못해 이전 버전으로 되돌렸어요. 기존 서비스는 그대로예요" + 대상별 되돌림 |
| rolled_back | skipped | stage failed(exit 4), performed=false | 주황 "전환 중에 문제가 생겨 이전 버전으로 되돌렸어요" |
| held | skipped | stage failed(exit 3), performed=false | 주황 "새 버전이 검사를 통과하지 못해 트래픽을 옮기지 않았어요. 기존 서비스는 그대로예요" + 검사 결과 |
| error | error | stage failed(exit 1), performed=false | 빨강 "트래픽을 넘기지 못했고, 일부 대상을 이전 버전으로 되돌리지 못했어요" + 되돌리지 못한 대상 |
| error | skipped | stage failed(exit 1), performed=false | 빨강 "배포 중 오류가 나서 멈췄어요". Cloud Run 이 활성화됐는데 되돌리지 못했으면 "Cloud Run 에는 새 버전이 올라가 있을 수 있어요" 추가 |
| activated | error | (최신 main 에서는 발생하지 않음) | 방어용 fallback: 빨강 "새 버전은 떴지만 트래픽 전환 실패" |
| (deploy_result 없음) | | stage failed(게이트 실패) | "배포 조건이 맞지 않아 시작하지 않았어요: {stage.error}" |
| (deploy_result 없음) | | stage skipped (`DEPLOY_MODE=off`), deployment 는 succeeded | "이 실행에서는 배포 단계를 건너뛰었어요" (performed=false 이므로 배포됨이라 쓰지 않음) |
| (stage 없음) | | | 정책에서 막혔거나 앞 단계에서 멈춘 이유 |

## 3. Application Detail

| 항목 | 출처 | 비고 |
|---|---|---|
| 현재 트래픽 위치(active) | `GET routing` → target.kind, target.id, revision | 404 → "아직 트래픽을 받는 곳이 없어요" |
| standby | `GET targets` 중 route target 과 같은 deploymentId 의 다른 enabled target. Cloud Run 에만 "대기: 장애 시 자동 전환" | 자동 failover 는 onprem → cloud_run 방향만 |
| 상태(health) | `targets[].health.status`(정상/응답 없음/확인 중), failureKind(연결이 끊김/앱이 오류 응답), consecutiveFailures/Successes, observedAt, expiresAt | expiresAt 지나면 "확인 중" |
| 장애 시 자동 전환 | route target 의 deploymentId 로 `GET /deployments/:id` 한 번 더 → `policyResult.failoverAllowed` | deployment 별 캐시 |
| 전환 횟수 | `routing.revision` | changedBy/reason 은 응답에 없음 |
| 에이전트 | `GET /agents/:id/status` (ids 는 application.agents[]) → On-Prem 카드 안에 연결됨/연결 끊김 | 에이전트가 없으면 조회 생략 |
| 배포 이력 | `GET /applications/:id/deployments` | 서비스 중인 배포 표시 |
| 세부 기술 정보 | target id, deployment id, 포트, URL, enabled, health.reason, 서빙 컨테이너 | 카드마다 접힘 |

- On-Prem / Cloud Run 카드 두 개 나란히. active 쪽은 "지금 여기로" 띠와 강조 테두리. target 이 없으면 "아직 없음" (임의 생성 금지).
- failover: 클라이언트가 이전 route 와 비교해 revision 또는 target 이 바뀌면 맨 위에 "장애 전환이 일어났어요" 배너. 이력 API 가 없어 이 화면에서 본 것만 기록.
- 실제 순서(backend-v2 e2e): healthy → 1회 실패 unknown(consecutiveFailures 1) → 2회 unhealthy → route 가 cloud_run 으로, revision +1. SSH 끊김만으로는 전환 없음, 자동 failback 없음.
- 폴링 5초 (routing, targets, agent status, deployments 함께).

## 4. real mode 와 인증

- 프론트는 상대 경로로만 요청하고 Vite 프록시(`/auth, /applications, /deployments, /agents, /users, /healthz`)가 `VITE_BACKEND_URL` 로 전달한다. 원격 주소면 Host 헤더를 대상으로 바꾼다. `npm run preview` 도 같은 프록시를 쓴다.
- 연결 상태(상단 바): `/healthz` 가 `{ok:true}` 가 아니면 빨강 "백엔드 연결 안 됨", 토큰이 없거나 401/403 이면 주황 "로그인 필요", `/users/me` 성공 때만 초록. 실패해도 mock 으로 자동 전환하지 않는다.
- 체크리스트: 1) 백엔드 2) 토큰(access token 붙여넣기 → localStorage → Authorization 헤더) 3) 앱 선택(`GET /applications` 목록 클릭). id 직접 입력은 "고급".
- 401 이면 "토큰이 만료되었습니다. 새 토큰을 입력하세요". 자동 refresh 는 하지 않는다.
- 로그인·앱 생성 화면은 만들지 않는다.
- **실제 팀 backend-v2 와의 연결과 GitHub OAuth 로그인은 아직 검증하지 않았다.**

## 5. mock 시나리오

| # | 내용 | 기본 화면 | 데이터 출처 |
|---|---|---|---|
| ① | 방명록 block. restart 14/20, replace 13/20. requires fix_restart_failure(R1b)·managed_db(R5)·object_storage(R6), 모두 allowed_targets [onprem] | Deployment Detail | parity/result3.json 불일치 목록, policy.yaml 문구, signer block.plan 형식 |
| ② | allow → activated. 온프레 primary(rev 1), Cloud Run standby enabled | Deployment Detail | backend/.work 방명록 allow 실행(plan·sign·explain), main deploy_result 형식 |
| ③ | v3 Cloud Run 후보 health 503 → held, discard. route 는 v2 온프레 유지 | Deployment Detail | ② + held 의미 |
| ④ | 온프레 장애 → failover. 5초 프레임: healthy → unknown(1) → unhealthy(2, network) → route cloud_run rev 2, 에이전트 offline | Application Detail | backend-v2 e2e failover 테스트 순서 |

mock 데이터는 `src/mocks/` 에 있고 실제 API 응답과 같은 구조다. 화면 컴포넌트는 mock/real 을 구분하지 않는다(`src/api/client.ts` 의 `DataSource` 인터페이스만 본다).

## 6. 지금 main 만으로 확인 가능한 것 / 기다려야 하는 것

| 항목 | 상태 |
|---|---|
| `/healthz`, `/users/me`, applications, deployments, policyResult/stages/artifacts, routing/targets/agent status | main 만으로 가능 (실연결은 미검증) |
| deploy_result activated/held/rolled_back/error | main 만으로 가능 (#26 머지됨). `DEPLOY_MODE=real` + GCP·cosign 환경 필요 |
| 증명 체인 "같은 코드" ✓, `facts.conditions` 막대 | #29 통합 필요 (그 전에는 "확인 전", 막대 없음) |
| webhook 배포의 verified 의미 | #33 머지 필요 (그 전까지 stub 여부로 보정) |

## 7. 백엔드에 바라는 것 (프론트에서 수정하지 않음)

- `GET /applications/:id/routing` 응답에 `changedBy`, `reason` 포함. 또는 `routing_changes` 조회 API.
- OAuth 콜백 뒤 프론트로 리다이렉트하는 옵션(`?redirect_uri=` 화이트리스트).
- CORS 또는 backend-v2 의 정적 파일 서빙(`@nestjs/serve-static`). 데모는 프록시로 우회 가능.
- `deploy_result` 공통 계약(contracts/) 추가. 지금은 `schemaName: null`.
