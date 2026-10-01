# 온프레 작업함 (조율기 ↔ 온프레 에이전트)

초안. 조율기(준하)와 온프레 에이전트(태현)가 GCS 버킷으로 작업을 주고받는 형식입니다.
에이전트가 작업을 가져가는 pull 방식이라 온프레에 관리용 포트를 열지 않습니다.
배포 파트 내부 형식이라 루트 contracts/에는 올리지 않습니다.

## 위치

버킷: `gs://hib-hackathon-1004-deploy-mailbox` (서울 리전, 공개 차단, 7일 지난 파일 자동 삭제)

| 경로 | 쓰는 쪽 | 읽는 쪽 | 내용 |
|---|---|---|---|
| `onprem/jobs/<job_id>.json` | 조율기 | 에이전트 | 할 일 하나 |
| `onprem/results/<job_id>.json` | 에이전트 | 조율기 | 그 일의 결과 |
| `onprem/status.json` | 에이전트 | 조율기 | 지금 서비스 중인 버전과 마지막 확인 시각 |

## job_id

`<run_id>-<action>-<순번 2자리>` 예: `run-20261001-001-candidate-01`

- 같은 job_id의 결과 파일이 이미 있으면 에이전트는 다시 실행하지 않습니다 (중복 방지)
- 같은 run에서 같은 action을 다시 시도하면 조율기가 순번을 올립니다

## job (조율기 → 에이전트)

| 필드 | 필수 | 설명 |
|---|---|---|
| `job_id` | 예 | 위 규칙 |
| `run_id` | 예 | backend 실행 번호 |
| `action` | 예 | `candidate` / `activate` / `rollback` / `discard` |
| `digest` | 예 | 이번 실행의 멀티 아키텍처 인덱스 digest |
| `image` | candidate | `<저장소>@<digest>` 전체 주소 |
| `plan_hash` | candidate | cosign 확인용 주석 값 |
| `to_digest` | rollback | 되돌아갈 버전의 인덱스 digest (류진님 rollback_plan의 serve_digest) |
| `created_at` | 예 | 만든 시각 (ISO 8601) |
| `deadline` | 예 | 이 시각이 지나면 시작하지 않고 error 결과를 남김 |

## result (에이전트 → 조율기)

| 필드 | 필수 | 설명 |
|---|---|---|
| `job_id`, `run_id`, `action` | 예 | job과 같은 값 |
| `result` | 예 | `ok` / `error` |
| `candidate` | candidate | `{digest, container, url}` 새로 띄운 후보 (url은 기기 안 주소) |
| `check` | candidate | 공통 검사 CLI 출력 그대로 (`mode: candidate`) |
| `previous` | activate | `{digest, container, run_id}` 전환 전 버전 |
| `serving` | activate, rollback | `{digest, container, run_id}` 지금 서비스 중인 버전 |
| `error` | error일 때 | 사유 |
| `finished_at` | 예 | 끝난 시각 |

## status.json (에이전트가 주기적으로 덮어씀)

| 필드 | 설명 |
|---|---|
| `agent_id` | 기기 이름 (예: `mac-taehyun`, `oracle-arm`) |
| `updated_at` | 마지막 확인 시각. 30초 넘게 안 바뀌면 조율기는 온프레가 멈춘 것으로 봄 |
| `serving` | `{run_id, digest, container}` 지금 서비스 중인 버전 |
| `public_url` | 지금 쓰는 터널 주소 (주소가 바뀌어도 라우터가 따라갈 수 있게) |

## 규칙

- 서명 확인: 에이전트는 candidate를 실행하기 전에 에이전트 설정에 미리 넣은 공개키로 확인합니다
  `cosign verify --key signer/keys/cosign.pub -a run_id=<run_id> -a plan_hash=<plan_hash> <image>`
  실패하면 컨테이너를 띄우지 않고 `result: error`
- digest: 결과와 상태에는 docker inspect 값이 아니라 job으로 받은 인덱스 digest를 적습니다
  (Cloud Run도 인덱스 digest를 amd64 digest로 바꿔 기록해서, 서명된 값은 따로 남깁니다)
- 순서: 에이전트는 job을 created_at 순서로 하나씩 처리합니다
- 전환: activate는 로컬 프록시 대상만 바꾸고, 이전 컨테이너는 진행 중인 요청이 끝난 뒤 정지하되 지우지 않습니다 (롤백용)
- 시간: 양쪽 모두 2초마다 확인. 조율기는 candidate 결과를 120초, 나머지는 30초까지 기다리고, 넘으면 실패로 처리합니다
  (candidate 실패 → 양쪽 후보 정리, 기존 유지 / activate 실패 → 전환한 대상 되돌림)

## 허들에서 정할 것

- 후보 컨테이너 이름과 포트 범위
- status.json 갱신 주기 (초안: 10초)
- 터널 방식 (Cloudflare 고정 터널 / Tailscale Funnel / ssh -R)과 public_url 갱신 방법
