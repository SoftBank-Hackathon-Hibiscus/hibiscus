# TASK 초안

> 상태: Draft
> 기준: `main` `a3e48e3`
> 담당 범위: 임태현 — On-Prem Agent, 작업 전달, Tunnel, Gateway, Routing, Webhook, 관리 API

## P0. 계약 확정

- [x] Backend API 폴링 작업함을 구현한다. 기존 GCS 조율기 연결은 별도 작업이다.
- [x] Job에 `schema_version`, `agent_id`, `attempt`, `lease_until`을 추가한다.
- [ ] Job Result 계약을 준하님과 최종 확인한다. Backend·Agent v1 구현은 완료.
- [ ] Agent Status와 heartbeat 계약을 준하님과 최종 확인한다. Backend·Agent v1 구현은 완료.
- [x] 후보 컨테이너 이름 규칙을 확정한다. `hibiscus-<run_id>-<digest 12자리>`를 사용한다.
- [x] 후보 컨테이너 포트 정책을 확정한다. Docker가 loopback host port를 자동 할당한다.
- [x] Job, Result, Status 계약 문서를 갱신한다.

## P1. Agent 작업 API

- [x] Agent 등록 API를 만든다.
- [x] Agent token 발급, 교체, 폐기 API를 만든다.
- [x] Agent token 인증을 만든다.
- [x] `GET /agent/v1/jobs/next` 폴링 API를 만든다.
- [x] Job lease와 중복 실행 방지를 만든다. Agent도 완료 결과를 상태 파일에 저장한다.
- [x] Job 결과 제출 API를 만든다.
- [x] heartbeat 제출 API를 만든다.
- [x] Agent, Job, Result를 DB에 저장한다.

API 전송 계약과 예시는 `backend-v2/README.md`의 `Agent API 계약 v1`에 있다. 기존 Job·Result·Status 초안 필드를 유지한다. 담당자 간 최종 계약 조율은 계속 필요하다.

## P2. On-Prem Agent

- [x] TypeScript Agent 프로그램을 만든다.
- [x] Backend 작업 API를 폴링한다.
- [x] Docker 이미지를 받는다.
- [x] `cosign`으로 이미지 서명을 확인한다.
- [x] `candidate` 작업을 실행한다.
- [x] 후보 컨테이너 Health Check를 실행한다.
- [x] `activate` 작업으로 새 컨테이너를 serving 상태로 확정한다.
- [x] `rollback` 작업으로 이전 컨테이너를 serving 상태로 복구한다.
- [x] `discard` 작업으로 후보를 제거한다.
- [x] 실행 결과와 heartbeat를 Backend에 보낸다.
- [x] Agent 재시작 후 상태 파일과 Docker 상태를 복구한다.
- [x] 실제 Docker·cosign으로 candidate → activate → rollback → discard smoke test를 통과한다.

실제 트래픽 전환은 Agent 내부 프록시가 아니라 Backend의 Application Route 변경으로 처리한다. Agent는 이전 컨테이너를 롤백용으로 유지한다.

## P3. SSH Reverse Tunnel

- [x] VM Backend가 앱별 loopback 전달 포트를 할당한다.
- [x] Agent token으로 SSH 전달 목록을 조회한다.
- [x] Agent가 VM으로 outbound 연결하게 한다.
- [x] Agent가 `ssh2` Node 모듈 연결 하나로 여러 전달 규칙을 관리한다.
- [x] Agent가 최초 실행에서 ED25519 키를 자동 생성한다.
- [x] 1회용 등록 token으로 공개키만 Backend에 등록한다.
- [x] `AuthorizedKeysCommand`가 DB 공개키와 Agent별 포트 제한을 조회한다.
- [x] Gateway 요청과 Agent 응답을 중계한다.
- [x] 연결 종료와 요청 시간 초과를 처리한다.
- [x] Agent 자동 재연결을 만든다.
- [ ] 운영 VM의 `sshd`, 전용 사용자, 공개키, 방화벽을 설정한다.
- [x] 새 등록 token 발급과 Agent token 폐기 시 SSH 키 폐기를 구현한다.

## P4. Gateway와 Routing

- [x] VM Backend에 Reverse Proxy를 만든다.
- [x] 운영 Host 이름과 개발용 `/_gateway/:slug`로 앱을 찾는다.
- [x] On-Prem 터널 또는 Cloud Run URL로 요청을 보낸다.
- [x] Backend Health Monitor가 Target 상태를 기록하고 Routing에 적용한다.
- [x] Hop-by-hop 헤더를 제거하고 요청·응답을 스트리밍한다.
- [x] 수동 라우팅 변경 API를 만든다.
- [ ] 도메인과 TLS를 설정한다.

## P5. Failover

- [x] Health 실패 횟수와 timeout은 Application별 설정을 사용한다.
- [x] 터널 종료만으로 즉시 전환하지 않는다. Health 실패 임계값을 사용한다.
- [x] HTTP 상태 오류는 `application`, 연결·SSH·timeout 오류는 `network`로 저장한다.
- [x] 자동 Failback은 하지 않는다. 복구 뒤 수동 Route 변경을 사용한다.
- [x] 쓰기 요청을 자동 재전송하지 않는다.

## P6. Webhook과 관리 기능

- [x] GitHub Webhook endpoint와 HMAC 검증을 만든다.
- [x] 중복 Webhook 요청을 차단한다.
- [x] 앱별 Health Check 설정 API를 만든다.
- [x] Agent, Job, SSH Tunnel, Routing 상태 조회 API를 만든다.

## 준하님과 같이 연결할 부분

- [ ] 조율기가 On-Prem `candidate`, `activate`, `rollback`, `discard` Job을 생성하게 한다.
- [ ] 조율기가 Agent 결과를 기다리게 한다.
- [ ] Cloud Run과 On-Prem 결과를 하나의 `deploy_result`로 합친다.
- [ ] Backend `deploy` 단계가 조율기를 호출하게 한다.
- [ ] 한쪽 활성화 실패 시 양쪽 롤백을 검증한다.

## 태현님 담당에서 제외

- Cloud Run 후보 Revision 생성
- Cloud Run 트래픽 전환과 롤백
- 배포 조율기의 최종 판단
- Cloud Run Health Monitor
- Cloud SQL과 GCP 배포 권한
- Python 조율기의 TypeScript 이전

## 권장 실행 순서

1. Job 계약
2. Agent 작업 API
3. Docker Agent
4. SSH Reverse Tunnel
5. Gateway와 Routing
6. Failover
7. Webhook과 관리 API
8. 조율기 통합 테스트
