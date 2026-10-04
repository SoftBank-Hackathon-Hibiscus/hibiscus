# hibiscus

SoftBank Hackathon 2026 Term1 · 팀 Hibiscus

**증명 기반 하이브리드 배포 서비스**
로컬에서 실제로 쓴 기록으로 배포 환경에서도 똑같이 동작하는지 확인하고, 정책과 승인을 통과한 이미지만 클라우드·온프레에 배포

## 전체 흐름

```
parity (기록·재생·판정) → policy (배포 허용·차단, 위치 결정) → signer (승인·서명) → deploy (배포·트래픽 전환)
```

- 파트 사이는 JSON 파일로만 주고받음
- 파일 형식은 `contracts/` 기준

## 폴더

| 폴더 | 내용 | 담당 |
|---|---|---|
| `contracts/` | 파트 간 공통 데이터 양식 | 공통 (류진) |
| `parity/` | 요청·응답 기록, 재생, 비교, 환경 조건 재현 | 윤선, 주영 |
| `policy/` | 정책 엔진 | 류진 |
| `signer/` | 승인·서명 | 승표 |
| `deploy/` | 배포, 트래픽 전환 | 태현, 준하 |
| `backend/` | 파이프라인 시작점: 실행(run) 관리, 단계 호출, 상태 기록 | 류진 |
| `sample-app/` | 데모용 방명록 앱 | 윤선 |
| `frontend/` | 애플리케이션 운영 콘솔 | 류진 |
| `tests/e2e/` | 전체 흐름 연결 테스트 | 공통 |

파트별 테스트는 각자 폴더 안에 (`policy/tests/` 등)

## 운영 콘솔

실제 콘솔은 `frontend/`, API는 `backend-v2/`, On-Prem 실행과 로그 수집은 `onprem-agent/`에서 제공합니다.

- 개요: 현재 서비스 버전, 최근 배포, 대상 상태를 표시합니다.
- 배포 이력: 목록에서 배포를 선택합니다. 상세 화면은 단계별 오류와 실행 출력을 표시합니다.
- 로그: 배포 버전, 실행 대상, 시간, 수준, 검색어로 조회합니다. On-Prem 로그는 Agent가 수집하고, Cloud Run 로그는 해당 revision으로 제한합니다. 알려진 환경변수 비밀값은 숨깁니다.
- 트래픽: React Flow로 서비스 경로를 표시합니다. Gateway에서 완료된 요청을 기준으로 초당 요청 수, 5xx 비율, 지연 시간을 집계합니다. 직접 대상에 보낸 요청은 포함하지 않습니다. 집계는 API 재시작 시 초기화됩니다.
- 배포 설정: Health Check, 실행 환경변수, 검증 환경변수를 저장합니다. 기존 값은 빈 입력으로 유지합니다. 저장과 저장 후 배포를 구분합니다. 검증 단계 끄기는 제공하지 않습니다.

On-Prem 로그는 업데이트된 Agent가 필요합니다. 저장 기간은 24시간이고 앱당 최대 10,000건입니다. 화면은 최근 150건을 표시합니다. Cloud Run 조회는 최근 1,000건 안에서 필터링합니다.

API: `PATCH /applications/:id/settings`, `GET /applications/:id/logs`, `GET /applications/:id/traffic`, `GET /applications/:id/routing/history`. 모두 로그인이 필요합니다.

## 작업 방법 (예시, 회의에서 확정)

- main에 바로 push하지 않고 브랜치 → PR → 한 명 확인 후 merge
- 자기 파트 폴더만 수정, 다른 폴더는 그 파트에 먼저 말하기
- `contracts/` 바꿀 때는 Slack 채널에 공유
- API 키, GCP 키, 서명 키 같은 비밀값은 절대 커밋 금지

## Commit convention

Keep it short and in English: `<type>(<scope>): <summary>`

- **type**: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`
- **scope**: folder name (`parity`, `policy`, `signer`, `deploy`, `contracts`, `sample-app`, `e2e`)
- **summary**: imperative, lowercase, no trailing period, about 50 chars max

```
feat(signer): add approval record bound to plan_hash
fix(policy): narrow targets when pii is detected
test(e2e): connect parity result to policy engine
docs: update folder owners
```

Branch name: `<scope>/<short-desc>` (e.g. `signer/approval-cli`)

## 링크

- Notion 팀 페이지: https://app.notion.com/p/term1_team_hibiscus-db48bee9ada48277897001c7e3e32cdf
