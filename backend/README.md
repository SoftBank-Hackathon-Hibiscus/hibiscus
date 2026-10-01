# backend

파이프라인 시작점: 실행(run) 관리, 단계 호출, 상태 기록 (류진)

```
수동 실행 → [테스트 stub] → [정책 policy/] → [서명 signer/] → [배포 deploy/]
```

- 백엔드는 **호출하고 상태만 기록**한다. 허용·차단·서명 여부 같은 판단은 각 파트 모듈이 한다.
- run 1회당 `run_id` 1개를 백엔드가 만들고(UUID), 모든 단계에 같은 값을 넘긴다.
- 파트 사이는 JSON 파일로만 오간다. 백엔드는 파일 경로를 관리하고 결과 파일을 StageExecution 에 기록한다.
- 지금은 **뼈대(execution_mode=skeleton)** 다. 테스트는 stub, 서명은 dry-run, 배포는 건너뛴다. 실제 배포는 일어나지 않는다.

## 실행

```bash
cd backend && npm install
cp .env.example .env      # 필요한 값만 채운다. 기본값으로도 뜬다
npm start                 # http://localhost:8080
npm run dev               # 파일 바뀌면 재시작
npm test
npm run typecheck
```

필요한 것: Node 22.9 이상, `policy/`, `signer/` 에 `npm install` 되어 있을 것, 앱 소스 폴더가 git 저장소 안에 있으면 `git`.
cosign, gcloud, Docker 는 필요 없다 (dry·off 모드).

서버는 기본으로 `127.0.0.1` 에만 열린다 (`HOST` 로 바꿀 수 있음). **webhook·인증이 붙기 전에는 외부 공개용이 아니다.**

한 바퀴 돌려 보기:

```bash
curl -s -X POST localhost:8080/apps -H 'content-type: application/json' \
  -d '{"name":"guestbook","src_path":"sample-app","image_repo":"asia-northeast3-docker.pkg.dev/hib/apps/guestbook"}'
# → {"id":"<app_id>", ...}

curl -s -X POST localhost:8080/apps/<app_id>/runs -H 'content-type: application/json' -d '{"requester":"ryu"}'
# → 202 {"run_id":"<run_id>","status":"queued", ...}

curl -s localhost:8080/runs/<run_id>
# → {"run":{"status":"succeeded","decision":"allow","execution_mode":"skeleton","deployment_performed":false, ...},
#    "stages":[{"stage":"test","status":"succeeded"},{"stage":"policy","status":"succeeded"},
#              {"stage":"sign","status":"succeeded"},{"stage":"deploy","status":"skipped"}]}
```

## API

| 메서드 | 경로 | 하는 일 | 응답 |
|---|---|---|---|
| POST | `/apps` | 앱 등록. `name`, `src_path`(REPO_ROOT 기준 또는 절대 경로, 폴더여야 함), `image_repo`(태그 없는 저장소), 선택 `repo`, `default_branch`, `policy_path`, `test_template`(`allow` 기본 / `block-test-failed`) | 201 앱 |
| GET | `/apps` | 앱 목록 | 200 |
| GET | `/apps/:id` | 앱 하나 | 200 / 404 |
| POST | `/apps/:id/runs` | 수동 실행. `requester`(필수), `source_revision`(선택, 소문자 hex 7~40자), `digest`(선택, `sha256:` + hex 64자). 단계는 백그라운드로 돈다 | 202 run / 400 / 404 |
| GET | `/runs/:id` | run + StageExecution 목록 | 200 `{ run, stages }` / 404 |
| POST | `/runs/:id/approve` | needs_approval 로 멈춘 run 승인. `approver`(필수). signer `approve` → `sign --approval` 순서로 이어서 돈다. 요청자 본인이면 403 이고 run 은 awaiting_approval 그대로. 같은 run 에 승인이 동시에 오면 먼저 시작한 것만 진행하고 나머지는 409 | 202 run / 403 / 409 |
| GET | `/healthz` | 살아 있는지 | 200 |

webhook(`POST /webhooks/github`)은 다음 PR 에서 만든다.

## run 상태

| status | 뜻 |
|---|---|
| `queued` | 만들어졌고 아직 단계 시작 전 |
| `running` | 단계 실행 중 (`current_stage` 가 어느 단계인지) |
| `awaiting_approval` | 정책이 needs_approval. `POST /runs/:id/approve` 를 기다림 |
| `blocked` | 정책이 block. 서명·배포 단계는 만들지 않는다 |
| `failed` | 어느 단계가 실행 오류·거절. `error` 에 `[단계] 이유` |
| `succeeded` | 서명까지 끝났고 배포 단계가 끝나거나 건너뜀 |

StageExecution 의 `status` 는 `pending | running | succeeded | failed | skipped`. 배포를 끄면 deploy 는 `skipped` 다.
`artifacts` 는 산출물 이름 → **WORK_DIR 기준 상대 경로** (`runs/<run_id>/policy/plan.json` 처럼).

## 응답에 항상 있는 값

| 필드 | 뜻 |
|---|---|
| `execution_mode` | 이번 PR 에서는 항상 `"skeleton"`. 테스트 stub, dry 서명, 배포 생략으로 돈 실행이라는 표시 |
| `deployment_performed` | 실제 배포 조율기가 돌았는지. 지금은 항상 `false` |
| `digest_source` | `"registry"` 요청에 digest 를 넣었음 / `"placeholder"` 없어서 백엔드가 자리표시자를 만듦 (`sha256(placeholder:<run_id>)`, 형식만 맞춘 값) |
| `source_revision_verified` | 앱 소스가 git 저장소여서 HEAD 로 확정했고 커밋 안 된 변경이 없을 때만 `true` |

### source_revision 확정 규칙 (`src/git.ts`)

| 상황 | 결과 |
|---|---|
| 앱 소스가 git 저장소, 요청에 값 없음 | `git rev-parse HEAD` 값 사용, verified=true |
| 요청 값이 HEAD 와 같음 (앞부분 일치 포함) | HEAD 전체 SHA 로 확정, verified=true |
| 요청 값이 HEAD 와 다름 | **400 거부**, run 을 만들지 않음 |
| 폴더에 커밋 안 된 변경 있음 (`git status --porcelain -- .`) | verified=false |
| git 저장소가 아니거나 HEAD 를 못 구함 | 요청 값 사용, verified=false. 요청 값도 없으면 400 |

verified=false 면 real 서명·real 배포는 거부된다.

## 파트 경계 검증

백엔드는 판단을 새로 하지 않는다. 대신 단계 산출물이 **지금 run 과 같은 실행·같은 이미지**를 가리키는지 확인하고, 아니면 그 단계를 failed 로 끝낸다 (`error` 에 어느 값이 어떻게 다른지 적는다).

| 산출물 | 먼저 형식 검사 | 그다음 교차 검증 |
|---|---|---|
| `policy/plan.json` | 루트 `contracts/Plan.schema.json` | `run_id == run.run_id`, `digest == run.digest`, `source_revision`(있으면) `== run.source_revision`, `decision ==` CLI 종료 코드로 해석한 decision |
| `sign/sign_result.json` | 루트 `contracts/SignResult.schema.json` | `run_id == run.run_id`, `digest == run.digest`, `plan_hash == plan.json 의 plan_hash` |

스키마 파일을 읽지 못해도 실패로 본다. 계약 파일은 백엔드가 고치지 않는다 (`contracts/README.md` 의 절차).

## 모드 스위치

| 변수 | 값 | 동작 |
|---|---|---|
| `SIGNER_MODE` | `dry` (기본) | signer 를 `--dry-run` 으로 호출. `signature_ref` 가 `dry-run:` 으로 시작. stub 승인 허용 |
| | `real` | cosign 으로 실제 서명 (`SIGNER_COSIGN_KEY`, `COSIGN_PASSWORD` 는 signer 가 읽음). `digest_source=registry` 이고 `source_revision_verified=true` 일 때만 허용, 아니면 서명 단계가 오류로 멈춘다. stub 승인은 403 |
| `DEPLOY_MODE` | `off` (기본) | deploy 단계를 `skipped` 로 기록, `deployment_performed=false` |
| | `dry`, `real` | 아직 미구현. 단계가 "미구현" 오류로 끝난다. real 금지 규칙(dry-run 서명, verified=false, placeholder digest)은 `src/stages/deploy.ts` 에 미리 있다 |

| `HOST` | `127.0.0.1` (기본) | bind 주소. 바깥에 열려면 명시적으로 `0.0.0.0` |

그 밖의 변수는 [.env.example](.env.example) 에 있다.

## 실행 폴더

```
WORK_DIR/                       (기본 backend/.work, 커밋 안 함)
└── runs/<run_id>/
    ├── test/test_result.json   테스트 stub 이 만든 정책 입력
    ├── policy/                 정책 CLI --out-dir: plan.json, pii.json, test_result.json, migration.json, explain.ko.md, explain.ja.md
    ├── sign/                   approval.json, sign_result.json
    ├── deploy/                 (배포 조율기 OUT_DIR 자리. 지금은 비어 있음)
    └── decisions.jsonl         정책(kind: deploy)·서명(kind: sign) 기록. 두 CLI 의 --log 에 이 절대 경로를 넘긴다
```

결정 기록은 **run 별로 분리**한다. 동시에 두 run 이 돌 때 줄이 섞이지 않게 하기 위해서다. 전 run 공용 파일은 만들지 않는다. 중앙 감사 로그는 나중에 DB·GCS 로 모은다.
Cloud Run 에서는 인스턴스가 바뀌면 로컬 파일이 사라지므로 산출물 보관도 나중에 바꾼다.

## 단계가 실제로 부르는 명령

| 단계 | 명령 (cwd) |
|---|---|
| 테스트 | 없음. `fixtures/test-templates/<test_template>.json` 에 run_id, app, digest, source_revision 을 채워 `test/test_result.json` 생성 |
| 정책 | `npm run stage -- --src <앱 소스> --test <test_result.json> --policy <policy.yaml> --out-dir <run>/policy --log <run>/decisions.jsonl --source-revision <sha> --json --explain` (policy/). 종료 코드 0 allow / 2 needs_approval / 3 block / 1 오류 |
| 서명 | allow: `npm run sign -- --plan <plan.json> --requester <id> --image-repo <repo> --out <run>/sign/sign_result.json --log <run>/decisions.jsonl [--dry-run]` (signer/). needs_approval: 승인 뒤 `npm run approve -- --plan … --requester … --approver … --out approval.json` 다음 `sign … --approval approval.json`. 그 사이에 plan.json 을 다시 쓰지 않는다 (approval 이 plan 파일 해시에 묶임). 종료 코드 0 서명 / 1 거절 / 2 오류 |
| 배포 | 없음 (`DEPLOY_MODE=off`) |

Windows 에서는 npm 을 `npm.cmd` 로, cmd.exe 를 거쳐 실행한다 (`src/command-runner.ts`). 외부 명령은 `CommandRunner` 로 감싸 테스트에서 가짜로 바꾼다.

## 신원 (TBD)

`requester` 와 `approver` 는 **요청 본문의 id 를 그대로 쓴다. 아직 인증하지 않는다.**
signer 도 신원을 확인하지 않으므로 인증된 id 를 넘기는 것은 백엔드 책임인데, 어떻게 인증할지(GitHub 로그인, webhook 의 push 작성자 등)는 아직 정하지 않았다.
그래서 stub 승인 제공자(`src/approval/stub.ts`)는 `SIGNER_MODE=dry` 에서만 동작한다. 본인 승인은 signer 가 거절한다.

## 아직 안 된 것

- GitHub webhook (`POST /webhooks/github`, HMAC 검증, push 의 커밋 SHA 고정)
- 소스 체크아웃 (clone). 지금은 앱의 로컬 경로를 그대로 `--src` 로 쓴다
- real 서명 (cosign 키 연결), real·dry 배포 (deploy_result 형식은 배포 파트가 정함. PR #9)
- requester·approver 신원 인증, 인증된 승인 제공자
- 관리형 DB 저장소 (지금은 메모리. 프로세스가 끝나면 사라진다)
- 중앙 감사 로그, 산출물 보관 (GCS)
- 정책 입력을 `--test` 에서 `--handoff` 로 교체 (PR #12 머지 후). 테스트 stub 을 실제 parity 호출로 교체

TODO (알고 있지만 아직 손대지 않은 것):

- 수동 실행 중복 방지 (idempotency). webhook 붙일 때 같이
- Windows cmd.exe 인자 처리에서 `%`, `!` 같은 특수문자 완전 대응 (`src/command-runner.ts` 의 `quoteForCmd`)
- 시간 초과 시 Windows 에서 npm 의 자식 프로세스(tsx, node)까지 정리되는지 확인
- `src_path`, `policy_path` 사용자 입력 경로 제한. 인증·앱 설정 붙일 때

## 폴더

```
src/server.ts          서버 시작
src/app.ts             HTTP API (Hono)
src/pipeline.ts        run 생성, 단계 순서, 상태 기록, 승인 이어가기
src/build.ts           기본 조립 (메모리 저장소, 실제 명령 실행기, stub 승인)
src/config.ts          환경변수 → 설정
src/models.ts          DeploymentApp, DeploymentRun, StageExecution, API 입력 스키마
src/paths.ts           run 별 실행 폴더
src/git.ts             source_revision 확정
src/command-runner.ts  외부 명령 실행 (실제 / 주입 가능)
src/store/             저장소 인터페이스 + 메모리 구현
src/stages/            test-stub, policy, sign, deploy
src/approval/          승인 제공자 인터페이스 + stub
fixtures/test-templates/  테스트 stub 템플릿
tests/                 상태 전이(가짜 명령), 규칙 단위 테스트, 실제 CLI 통합 테스트
```
