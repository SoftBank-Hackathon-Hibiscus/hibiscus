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
| `frontend/` | 데모용 최소 UI | 류진 |
| `tests/e2e/` | 전체 흐름 연결 테스트 | 공통 |

파트별 테스트는 각자 폴더 안에 (`policy/tests/` 등)

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
