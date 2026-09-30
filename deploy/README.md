# deploy

배포, 트래픽 전환, 롤백 (태현, 준하)

## Cloud Run · 조율기 (준하)

### 폴더

| 폴더 | 내용 |
|---|---|
| `cloudrun/` | Cloud Run 후보 배포, 전환, 롤백, 후보 버리기 스크립트 |
| `coordinator/` | 조율기 v0: sign_result.json → 후보 → 검사 → 전환 또는 유지 → deploy_result.json |
| `examples/` | 입출력 예시. sign_result는 승표님 필드 초안, deploy_result는 실제 실행 결과 |
| `out/` | 실행 결과 저장 위치 (커밋 안 함) |

### 필요한 것

- gcloud (로그인, 프로젝트 권한), jq, Python 3.9 이상 (표준 라이브러리만 사용)
- 환경변수: `PROJECT_ID`, `REGION`, `SERVICE`, `IMG` 또는 `IMAGE_REPO`, `PORT`(기본 8080), `TAG`(기본 cand), `CHECK_PATH`(기본 /), `ONPREM_AGENT_URL`(비우면 온프레 건너뜀), `OUT_DIR`

### 실행

```bash
./coordinator/coordinator.py <sign_result.json>
```

종료 코드: 0 전환 완료 / 3 검사 실패로 기존 버전 유지 / 4 전환 중 실패해서 되돌림 / 1 실행 오류

스크립트만 따로 쓸 때:

```bash
cloudrun/candidate.sh <저장소@sha256:digest> [suffix]   # 트래픽 0% 배포, 후보 주소 출력
cloudrun/activate.sh                                  # 후보로 100% 전환, 직전 revision 출력
cloudrun/rollback.sh <revision>                       # 지정한 revision으로 100%
cloudrun/discard.sh                                   # 후보 태그만 제거
```

모든 스크립트는 결과를 JSON 한 줄로 stdout에, 진행 메시지는 stderr에 출력합니다.

### 규칙

- revision 이름은 `<서비스>-d<digest 앞 12자>`. digest만 알면 revision을 바로 찾고, 같은 digest가 다시 오면 새로 배포하지 않고 태그만 옮김
- 배포 위치는 sign_result의 targets를 그대로 따름. 배포 쪽에서 다시 판단하지 않음
- 전환 순서는 cloud_run 먼저, onprem 다음

### 아직 임시인 부분 (확정 전)

- 검사: 후보 주소가 HTTP 200을 주는지만 보는 임시 검사. 태현님 검사기로 교체 예정
- 온프레: 에이전트 API 형식이 확정 전이라 호출하지 않고 skipped로 기록. skipped 대상은 판단에서 빠짐 (임시)
- 전환 후 검사(live)와 rollback_request 생성은 다음 버전에서

### 실측 (10/1, 연습용 hello 서비스)

| 후보 배포 | 전환 | 롤백 | 조율기 통과 | 조율기 검사 실패 |
|---|---|---|---|---|
| 12.1초 | 5.6초 | 11.7초 | 15.5초 (종료 코드 0) | 21.9초 (종료 코드 3, 기존 버전 유지) |
