# 테스트 결과

실제로 돌려 본 것만 적습니다. 합성 fixture로 한 검사와 실제 Docker 실행, 팀 연동은 따로 적습니다.

## 2026-09-30 18:20 (KST) — M1

- 환경: Ubuntu 24.04 (WSL2), Python 3.12.9, Docker 28.0.1, jsonschema 4.26.0
- 소스: 개인 작업 저장소에서 개발하던 때(팀 레포로 옮기기 전), M1 커밋 직전 작업 트리
- 명령: `python -m premortem self-test --docker`

| 구분 | 결과 |
| --- | --- |
| 단위 테스트 (Docker 없이) | 70개 통과, 실패 0 |
| 실제 Docker 시험 | 2개 통과, 실패 0 |
| 팀 재생기(윤선님) 연결 | 안 함. 코드 없음 |
| 팀 계약(류진님) 연결 | 안 함. contracts, 변환기 없음 |
| live AI | 안 함. M2에서 |
| 클라우드 | 안 함. 이 모듈 범위 밖 |

### state-loss 샘플 (개발용, reference 재생, 실제 Docker)

- none 6/6 통과, restart 6/6 통과, replace 4/6 실패
- replace 4번: GET /notes/1 → 기대 200, 실제 404 / 5번: GET /notes → 기대 1건, 실제 빈 배열
- restart: 같은 컨테이너 ID, 시작 시각만 바뀜. replace: 새 컨테이너 ID, 같은 로컬 image ID
- 끝난 뒤 이 모듈이 만든 컨테이너 0개 남음. 다른 프로젝트 컨테이너는 그대로

### binding 샘플 원본 (개발용, 실제 Docker)

- none 실패: 게시 포트로 8초 동안 health 응답 없음, 컨테이너 안 health는 성공, LISTEN 127.0.0.1:8080 → binding 후보
- restart, replace: none이 실패해서 건너뜀

실패 도중 고친 것: 가짜 재생기로 돌린 테스트 2개가 처음에 실패했습니다. 하나는 테스트가 포트를 잘못 잡았던 것이고, 하나는 재생기 오류를 받는 곳이 없던 문제라서 코드를 고쳤습니다 (DEVLOG 5절 #1).

## 2026-09-30 18:25 (KST) — M2

- 명령: `python -m premortem self-test --docker`

| 구분 | 결과 |
| --- | --- |
| 단위 테스트 (Docker 없이) | 98개 통과, 실패 0 |
| 실제 Docker 시험 | 4개 통과, 실패 0 |
| live AI | 안 함. anthropic SDK와 키가 없음. 응답 처리는 가짜 응답으로만 확인 |
| 팀 재생기, 팀 계약 | 안 함 |

### binding 수정 루프 (개발용 샘플, AI는 fixture)

- 수정 전: none 0/4 실패 (binding 후보), restart·replace 건너뜀
- AI: fixture. 합성 예시 응답이고 실제 AI 호출이 아님
- 수정: app.py 한 줄 (`HOST = "127.0.0.1"` → `HOST = "0.0.0.0"`), 패치 가드 통과, 복사본에만 적용
- 다시 검사 (새 run_id, 새 이미지, 같은 session·noise): none 4/4, restart 4/4, replace 4/4 → 통과, 사람 검토 대기
- 원본 앱 파일 변화 없음. 수정 전 실행의 판정은 failed 그대로

### 녹화 재생

- 테스트용으로 합성한 live 모양 기록을 새 실행에 재생: 증거 ID와 소스 줄 검사를 통과하고 재검증 통과. 실제 호출 기록으로 해 본 것은 아님

## 2026-09-30 18:34 (KST) — 팀 연결 준비, 문서 정리 뒤 전체

- 명령: `python -m premortem self-test --docker`

| 구분 | 결과 |
| --- | --- |
| 단위 테스트 (Docker 없이) | 105개 통과, 실패 0 |
| 실제 Docker 시험 | 4개 통과, 실패 0 |
| plan.json requires 읽기 | 합성 plan으로만 확인 |
| live AI, 팀 재생기, 팀 계약 | 안 함 |

시연 시간(같은 날 실측): state-loss 19.8초, binding fixture 32.3초. 끝난 뒤 남은 테스트 컨테이너 0개.
