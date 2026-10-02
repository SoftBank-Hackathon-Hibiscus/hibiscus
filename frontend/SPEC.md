# 데모 프론트 화면 명세

기준: main `a37c3a8`, PR #26 `921a7cf` (deploy stage), PR #29 `c68b94d` (registry parity), PR #33 `35644ec` (sourceRevisionVerified 의미 정리). 2026-10-02.

#26·#29·#33 은 API 경로를 바꾸지 않는다. `GET /deployments/:id` 가 돌려주는 데이터만 달라진다.

## 1. API (main 기준)

인증은 전역 가드. `Authorization: Bearer <access JWT>`. 응답은 Drizzle row 그대로(camelCase), Agent 상태 응답만 snake_case. 전역 prefix 없음.

| Method | Path | 응답 주요 필드 | 비고 |
|---|---|---|---|
| GET | `/auth/github` | `{authorization_url}` + HttpOnly 쿠키(path `/auth/github`, 10분) | 공개 |
| GET | `/auth/github/callback` | JSON `{access_token, refresh_token, expires_in, user}` | 공개. 리다이렉트 없음 |
| GET | `/applications/:id` | `{application, healthCheck, agents[{id,name,status,lastSeenAt}]}` | agents[].status 는 DB 값 |
| GET | `/applications/:id/deployments` | `Deployment[]` version 내림차순 | |
| GET | `/deployments/:id` | `{deployment, stages[], policyResult, artifacts[](content 포함), auditLogs[]}` | |
| POST | `/deployments/:id/approve` | body `{}` → Deployment | 본인 승인 403, 대기 아님 409 |
| GET | `/applications/:id/targets` | `[{target, health\|null}]` | |
| GET | `/applications/:id/routing` | `{applicationId, target, revision, health}` | 첫 PATCH 전 404 |
| GET | `/agents/:id/status` | `{agent_id, status, last_seen_at, updated_at, received_at, serving, public_url}` | online/offline 계산값 |

main 에 없는 것: CORS 설정, 정적 파일 서빙, routing 변경 이력 조회 API(`routing_changes` 테이블은 있고 insert 만 함), 콜백 리다이렉트, dev 토큰. 모두 프론트에서 우회한다 (프록시, vite preview, 클라이언트 diff, 토큰 붙여넣기).

## 2. Deployment Detail

출처는 모두 `GET /deployments/:id` 한 번. 앱 이름만 `GET /applications/:id`. `stages` 는 attempt 별 row 가 쌓이므로 **단계별 최대 attempt 만** 표시.

### 결과 요약 카드 (첫 화면, `src/lib/summary.ts`)

- 결론 한 문장: blocked → "차단됨: 재시작·교체 후 데이터가 사라집니다"(requires 에 fix_restart_failure 등이 있을 때) 또는 걸린 규칙 reason. activated+ok → "배포 완료: {위치}에서 서비스 중, {standby} 대기". held → "안전하게 보류: 새 버전 검사 실패, 기존 서비스 그대로". rolled_back → "이전 버전으로 복구됨". activated+routing error 와 error 만 빨강.
- 가로 4단계(테스트, 정책, 서명, 배포)에 한 단어 결과.
- 증명 체인 4줄. 값이 2개 이상 있고 모두 같을 때만 ✓, 다르면 "불일치", 값이 부족하면 "확인 전". `sourceRevisionVerified` 는 "미검증"으로 표시하고 실패색을 쓰지 않는다. plan_hash 는 정책↔서명만 직접 비교하고, deploy_result 에는 plan_hash 가 없어 cosign 서명 검증 기록으로 간접 확인한다고 적는다. mock 에서는 DEMO DATA 배지를 같이 둔다.
- 정책 결정과 고칠 것(requires)은 이 카드 안. 단계별 상세, 감사 기록, 산출물은 아래 접힘.

| 섹션 | 필드 | 출처 |
|---|---|---|
| 상단 | version, status, decision, deploymentPerformed, sourceRevisionVerified, error | `deployment` |
| identity | run_id(id), 커밋(sourceRevision), digest, digestSource, trigger, executionMode, requester, approver, currentStage, created/updated | `deployment` |
| Test | stage status·summary(`{stub, test_passed}` 또는 `{template, stub:true}`), passed, match, failures, `facts.conditions[]`(있으면 none/restart/replace 막대), facts.db, writes_local_file, migration | `stages[test]` + `artifacts[name=test_result]` |
| Policy | decision(크게), targets, failoverAllowed, requires[{id, hint, hint_i18n.ja, rule_id, allowed_targets}](크게), rules 중 matched/matched_after_block 의 reason(+ja), explain.ko/ja 원문, pii 표, planHash | `policyResult` + `artifacts[name=plan, pii, explain.ko, explain.ja]` |
| Approval | needs_approval 이면 policy 와 sign 사이에 카드. awaiting_approval 이면 승인 버튼, approver, approval 산출물(approved_at, plan_sha256) | `deployment` + `artifacts[name=approval]` |
| Sign | SignLog result(signed/refused)+reason, signature_ref(`dry-run:` 이면 모의 서명), signed_at, requester/approver, targets, failover | `stages[sign]` + `artifacts[name=sign_result]` + `auditLogs[kind=sign]` |
| Deploy | 아래 상태 조합 표 | `stages[deploy]` + `artifacts[name=deploy_result]` (#26) |
| Audit | kind, time, decision/result, rule_ids, plan_hash | `auditLogs[]` |
| Artifacts | 단계별 전체 목록, JSON 은 pretty, text 는 원문 | `artifacts[]` |

### 표시 규칙

- `decision` 과 `routing.result` 는 **별도 렌더**. activated + routing.result=error 는 경고 "새 버전은 떴지만 트래픽 전환 실패". 성공처럼 보이면 안 된다. 백엔드(#26 `921a7cf`)는 이 조합을 stage succeeded 로 기록하므로 stage 상태만 믿지 않는다.
- `deploymentPerformed=false` 면 "배포됨" 이라 쓰지 않는다 ("배포 안 됨").
- `sourceRevisionVerified` 라벨은 "테스트한 이미지 = 이 커밋". 의미는 #33 + #29: 생성 시 manual·webhook 모두 false, registry parity 검증(빌드 manifest 와 테스트 결과의 run_id·commit·digest 교차 확인) 뒤 true. 테스트가 block 이어도 true 일 수 있다.
- 산출물은 `name` 으로 고른다. 같은 이름이 두 단계에 있으면(test_result 는 test·policy 둘 다) 해당 단계의 것을 우선. `mediaType=application/json` 만 parse, 실패하면 원문 fallback. `explain.ko`·`explain.ja`(text/plain) 는 parse 하지 않는다.
- `executionMode=skeleton` 이면 규칙 이유·설명 문서·개인정보 판정 칸을 숨긴다 (plan.rules 는 `[{id:'skeleton'}]`, requires 는 id 만, pii·explain 산출물 없음). `facts.conditions` 가 없으면 조건별 막대를 숨긴다.
- `reason_i18n.ja`, `hint_i18n.ja` 가 있으면 한국어 아래 작게 같이 표시.
- 폴링: status 가 queued/running/awaiting_approval 일 때만 2초.

### deploy_result 상태 조합 (#26 `deploy-result.type.ts`)

`routing.result` 는 decision 이 activated 일 때만 ok/error, 나머지는 skipped.

| decision | routing.result | 백엔드 기록 | 화면 |
|---|---|---|---|
| activated | ok | stage succeeded, performed=true | 성공 "배포 완료, 트래픽 → {kind} (route rev N)", standby 표시 |
| activated | **error** | **stage succeeded, performed=true (#26 미수정)** | 경고 "새 버전은 떴지만 트래픽 전환 실패: {routing.error}", 수동 route 변경 안내 |
| activated | skipped | succeeded | 경고 "활성화됐지만 트래픽 전환 안 함" |
| held | skipped | failed(exit 3), performed=false | 경고 "보류: 기존 서비스 유지", 실패한 check·후보 |
| rolled_back | skipped | failed(exit 4), performed=true | 실패 "전환 중 실패, 이전 버전으로 복구 → {previous}" |
| error | skipped | failed(exit 1), performed=false | 실패 "오류". `targets[]` 에 rollback error 또는 cloud_run activate ok 가 있으면 "Cloud Run이 새 버전을 서빙 중일 수 있음" 추가 |
| (deploy_result 없음) | | stage failed(게이트 실패) | "배포 시작 안 됨: {stage.error}" |
| (deploy_result 없음) | | stage skipped (`DEPLOY_MODE=off`), deployment 는 succeeded | "생략됨" (performed=false 이므로 배포됨이라 쓰지 않음) |
| (stage 없음) | | | "미실행 또는 생략" |

## 3. Application Detail

| 항목 | 출처 | 비고 |
|---|---|---|
| 현재 route(active) | `GET routing` → target.kind, target.id, revision | 404 → "경로 없음" |
| standby | `GET targets` 중 route target 과 같은 deploymentId 의 다른 enabled target | 명시 필드 없음 |
| target health | `targets[].health.status`(healthy/unhealthy/unknown), failureKind(application/network), reason, consecutiveFailures/Successes, observedAt, expiresAt | expiresAt 지나면 unknown 으로 표시 |
| failover_allowed | route target 의 deploymentId 로 `GET /deployments/:id` 한 번 더 → `policyResult.failoverAllowed` | deployment 별 캐시 |
| route revision | `routing.revision` | changedBy/reason 은 응답에 없음 |
| agent 상태 | `GET /agents/:id/status` (ids 는 application.agents[]) | 에이전트가 없으면 조회 생략 |
| 배포 목록 | `GET /applications/:id/deployments` | 서빙 중인 배포 표시 |

- On-Prem / Cloud Run 카드 두 개 나란히. active 쪽을 크게(테두리·ACTIVE 라벨). target 이 없으면 "등록 안 됨" (임의 생성 금지).
- failover: 클라이언트가 이전 route 와 비교해 revision 또는 target 이 바뀌면 "failover 발생 (rev N → N+1)" 배너. 이력 API 가 없어 이 화면에서 관측한 것만 기록.
- 실제 순서(backend-v2 e2e): healthy → 1회 실패 unknown(consecutiveFailures 1) → 2회 unhealthy → route 가 cloud_run 으로, revision +1. SSH 끊김만으로는 전환 없음, 자동 failback 없음.
- 폴링 5초 (routing, targets, agent status, deployments 함께).

## 4. 인증

- access token 붙여넣기 → `localStorage` → `Authorization` 헤더.
- 401 이면 "토큰이 만료되었습니다. 새 토큰을 입력하세요". 자동 refresh 는 하지 않는다 (refresh_token 은 콜백 JSON 에 함께 오지만 데모에서 확보 절차가 확정되지 않아 보류).
- 로그인·앱 목록·앱 생성 화면은 만들지 않는다.

## 5. mock 시나리오

| # | 내용 | 기본 화면 | 데이터 출처 |
|---|---|---|---|
| ① | 방명록 block. restart 14/20, replace 13/20. requires fix_restart_failure(R1b)·managed_db(R5)·object_storage(R6), 모두 allowed_targets [onprem] | Deployment Detail | parity/result3.json 불일치 목록, policy.yaml 문구, signer block.plan 형식 |
| ② | allow → activated. 온프레 primary(rev 1), Cloud Run standby enabled | Deployment Detail | backend/.work 방명록 allow 실행(plan·sign·explain), #26 deploy_result 형식 |
| ③ | v3 Cloud Run 후보 health 503 → held, discard. route 는 v2 온프레 유지 | Deployment Detail | ② + deploy/coordinator held 의미 |
| ④ | 온프레 장애 → failover. 5초 프레임: healthy → unknown(1) → unhealthy(2, network) → route cloud_run rev 2, 에이전트 offline | Application Detail | backend-v2 e2e failover 테스트 순서 |

## 6. 백엔드에 바라는 것 (프론트에서 수정하지 않음)

- #26: activated + routing.result=error 를 stage failed(또는 별도 상태)로 기록하고 회귀 테스트 추가 (리뷰 지적 미수정).
- `GET /applications/:id/routing` 응답에 `changedBy`, `reason` 포함. 또는 `routing_changes` 조회 API.
- OAuth 콜백 뒤 프론트로 리다이렉트하는 옵션(`?redirect_uri=` 화이트리스트).
- CORS 또는 backend-v2 의 정적 파일 서빙(`@nestjs/serve-static`). 데모는 프록시로 우회 가능.
- `deploy_result` 공통 계약(contracts/) 추가. 지금은 `schemaName: null`.
