# premortem

parity 안에서 배포 환경 조건을 재현하고, AI 수정안을 같은 기록으로 다시 검사하는 부분입니다. (주영)

- replace: i번 요청의 응답을 받은 뒤 컨테이너를 같은 이미지로 새로 만들고 이어서 재생합니다. restart로는 안 잡히는 파일 유실을 봅니다.
- 바인딩 확인: 컨테이너 밖에서 응답이 없을 때 안에서 health를 따로 불러 보고 listen 주소를 확인해서, 127.0.0.1 바인딩 후보인지 판단합니다.
- AI 수정 후 재검증: AI 수정안을 검사해서 복사본에만 적용하고, 새 이미지로 같은 기록을 처음부터 다시 돌립니다. 원본은 사람이 확인한 뒤에만 바꿉니다.

## 지금 상태

- 로컬 검토본의 `test-build`는 윤선님 실행기로 같은 이미지의 세 조건을 시험합니다. 기존 `demo`는 샘플 전용 reference 재생기를 사용합니다.
- 바인딩 예제에서 실제 AI 호출(`claude-sonnet-5-5`)로 받은 수정안을 복사본에 적용하고 세 조건 모두 4/4를 확인했습니다. 응답은 저장해 반복 검증에 사용하며, 호출하지 못하면 오류를 기록합니다.
- 정책 입력(test_result)은 원본 result·facts·handoff를 류진님 변환기에 넘겨 만듭니다. env_report는 환경 진단·AI 분석용 내부 결과입니다.

샘플 결과: 메모 앱은 컨테이너를 새로 바꾸면(replace) 6건 중 4건만 맞습니다(restart는 6건 다 맞음). 127.0.0.1 앱은 AI 수정 후 같은 기록으로 다시 돌려서 none, restart, replace 모두 통과합니다.

## 실행

`parity/`에서 실행합니다. build, demo, `--docker` 시험에는 Docker가 필요합니다.
AI 수정 기능은 jsonschema가 있어야 AI 출력을 받아들입니다: `pip install -r requirements.txt`

```sh
python -m premortem doctor
python -m premortem demo --scenario state-loss
python -m premortem demo --scenario binding --ai fixture
python -m premortem self-test            # Docker 없이
python -m premortem self-test --docker   # 실제 Docker 시험까지
```

실행 결과는 `premortem/.runs/`에 쌓이고 커밋되지 않습니다. 테스트 컨테이너는 `premortem.owner=juyeong` 라벨이 붙은 것만 만들고 지웁니다.

## 레지스트리 빌드

`build`는 커밋된 앱을 빌드해 레지스트리에 올리고, 업로드한 이미지의 식별값을
`build_manifest.json`에 남깁니다. Docker Buildx와 대상 레지스트리의 push/pull 권한이 필요합니다.
로그인은 Docker의 기존 인증 설정을 사용합니다. 이 명령이 계정이나 IAM 권한을 바꾸지는 않습니다.

```sh
python -m premortem build \
  --app ../sample-app \
  --image-repo asia-northeast3-docker.pkg.dev/hib-hackathon-1004/hib/guestbook \
  --run-id rehearsal-001 \
  --out-dir premortem/.runs/build-rehearsal-001 \
  --builder hib-builder \
  --json
```

`hib-builder`는 예시 이름입니다. `docker buildx ls`에서 실제 builder 이름을 확인해 지정합니다.
기본 platform은 `linux/amd64,linux/arm64`입니다. 두 platform을 빌드하고 registry로 내보낼 수 있는
builder가 필요하며, Dockerfile의 `RUN`을 실행하려면 해당 아키텍처의 실행 환경도 필요합니다.
로컬 단일 아키텍처 확인에는 `--platforms linux/amd64`처럼 지정할 수 있습니다.
BuildKit provenance를 켜므로 이 경우에도 최상위 **index digest**를 기록합니다.
`--timeout`은 빌드와 pull 각각의 제한 시간이며 기본 900초입니다.

소스는 앱 경로의 HEAD 커밋에서 추출합니다. 앱 경로에 미커밋 변경이나 미추적 파일이 있으면
멈추며, Git ignored 파일은 빌드에 들어가지 않습니다. 기존 스냅샷 규칙에 따라 `.env`, 키 파일,
symlink, 의존성 폴더도 제외하고 목록을 기록합니다. 의존성은 Dockerfile에서 설치해야 합니다.
Dockerfile은 앱 폴더 바로 아래에 있어야 하며, submodule은 지원하지 않습니다.

검증 순서는 다음과 같습니다.

1. 커밋의 소스 복사본으로 빌드하고 소스 커밋·내용 hash·run ID를 이미지 라벨에 넣습니다.
2. 고유 태그로 push하고 Buildx가 반환한 index digest를 읽습니다.
3. `repository@digest`로 index와 아키텍처별 manifest를 다시 읽어 내용 hash와 platform을 확인합니다.
4. 같은 index digest로 Docker 호스트 platform의 이미지를 pull합니다. 로컬 이미지 ID가 해당
   platform manifest의 config digest와 같은지, 소스 라벨이 맞는지 확인합니다.
5. 모두 맞을 때만 `build_manifest.json`을 씁니다. 실패하면 `build_error.json`을 남기고 0이 아닌
   종료 코드로 끝납니다. 이미 있는 결과 폴더는 덮어쓰지 않습니다. push 후 검증에 실패했다면
   레지스트리에 이미지는 남을 수 있으므로 성공 manifest의 유무로 완료 여부를 판단합니다.

| 기록 | 의미 |
|---|---|
| `source.commit` / `subdir` | 빌드 소스 커밋 전체 SHA와 저장소 안 앱 경로 |
| `source.tree_sha256` | 빌드에 넘긴 파일의 경로·내용 hash (기존 스냅샷 방식) |
| `image.reference` / `registry_digest` | 다음 단계에 넘길 `repository@index_digest`와 index digest |
| `image.platforms[platform].manifest_digest` | 해당 아키텍처 이미지 manifest의 digest |
| `image.platforms[platform].config_digest` | 해당 이미지 config의 digest |
| `image.local_image_id` / `platform` | 실제 pull해서 확인한 로컬 이미지 ID와 platform |
| `image.source_build_link_verified` / `registry_link_verified` | 이 빌드 명령의 소스 라벨·로컬 ID 연결 검사 결과 |

`schema_version`은 `premortem.build.v1`입니다. 이는 빌드 기록이며 정책 통과나 배포 완료를 뜻하지 않습니다.
조건별 재생은 실행하지 않습니다. 기존 `demo`/`run`/`handoff`에 이 이미지를 넘기는 연결은 별도 작업입니다.
pull한 로컬 이미지는 다음 검사에서 쓸 수 있도록 남겨 둡니다.

## 빌드 이미지 검사와 정책 확인

아래 연결은 PR #10, #12, #15, #21을 함께 읽는 로컬 검토본입니다. 각 PR의 병합 여부와 별개로
확인한 것이며, 기존 Backend의 TestStage에는 등록하지 않았습니다.

```sh
python -m premortem test-build \
  --build-manifest <빌드폴더>/build_manifest.json \
  --record <기록폴더>/session.jsonl --noise <기록폴더>/session.noise.json \
  --name guestbook --out-dir <새검사폴더> --after 10 --json

python -m premortem policy-preview \
  --test-dir <검사폴더> --out-dir <새정책폴더> --json
```

`test-build`는 registry의 index와 platform manifest를 다시 읽고 소스 hash와 이미지 라벨을 대조합니다.
태그를 다시 빌드하지 않고, pull한 로컬 이미지 ID를 윤선님 `parity.execution.run_test`에 넘깁니다.
새 컨테이너와 고정된 loopback 포트를 사용하며 none, restart, replace를 모두 실행합니다.
교체된 컨테이너도 소유 라벨을 확인한 뒤 정리합니다. Docker 호스트 platform이 index에 있으면
빌드한 PC와 다른 아키텍처에서도 같은 index로 검사할 수 있습니다.

원본 `result.json`과 `result.diagnostics.json`은 수정하지 않습니다. 실제 digest와 소스 커밋은
`verified.diagnostics.json`에, 원본 facts를 포함한 인계 묶음은 `parity_handoff.json`에 둡니다.
`execution_manifest.json`은 각 파일의 hash와 이번 실행의 식별값을 기록합니다.
handoff 안의 `caller_asserted`는 기존 parity 형식을 유지한 값이며, 추가 이미지 검증은 별도 빌드·실행 기록에 남습니다.
실행이 중단되면 원본 부분 결과를 보존하고 정책 인계 파일은 만들지 않습니다.

`policy-preview`는 파일 hash와 식별값을 먼저 확인한 뒤 류진님 정책 실행기를 부릅니다.
`policy/`에서 `npm ci`가 필요합니다. 입력은 원본 handoff와 검증 진단, 소스는 빌드 당시 복사본입니다.
분류기는 `heuristic`으로 고정합니다. 정책 규칙을 재구현하지 않으며 서명·배포는 호출하지 않습니다.

| 명령 | 종료 코드 |
|---|---|
| `test-build` | 0: 앱 검사 통과, 3: 완료했지만 불일치, 1: 입력·실행·정리 오류 |
| `policy-preview` | 정책 CLI와 같음. 0: allow, 2: needs_approval, 3: block, 1: 실행 오류 |
| `backend-test` | 0: 원본 시험과 정책 변환 완료. 앱 `passed=false`도 포함. 그 외: 다음 단계로 진행 금지 |
| `repair-build` | 0: 수정 복사본 재검증 통과, 2: AI 호출·수정 미완료, 3: 패치 거부·재검증 실패, 1: 실행 오류 |

현재 비교 범위는 요청 200건 이하와 빈 컨테이너 쓰기 계층입니다. 기존 볼륨·서비스 컨테이너는 받지 않습니다.
테스트와 정책 결과 폴더는 새로 만들어야 하며, 완료 결과를 덮어쓰지 않습니다.

## Backend 호출부

`integrations/backend_v2.ts`의 `runParityTestStage`가 PR #20의 CommandRunner와 StageOutcome 형태에
맞춰 Python 명령을 호출합니다. `repoRoot`, `pythonCommand`, `artifactRoot`, `outputDir`는 Backend 설정에서
주고, `request`에는 아래 값을 전달합니다. `build_manifest`, `record`, `noise`는 실행 환경의 절대 경로입니다.
앱 설정과 실행 정보 중 어느 곳에서 이 세 경로를 관리할지는 태현님 코드에 연결할 때 정해야 합니다.

```json
{
  "format": "premortem-backend-test-v1",
  "run_id": "Backend가 만든 deployment.id",
  "app": "guestbook",
  "source_revision": "앱 커밋 전체 SHA",
  "digest": "레지스트리 index digest",
  "build_manifest": "/workspace/build/build_manifest.json",
  "record": "/workspace/records/session.jsonl",
  "noise": "/workspace/records/session.noise.json",
  "after": [10]
}
```

호출 명령은 `python -m premortem backend-test --request <요청.json> --out-dir <단계폴더> --json`입니다.
단계 폴더는 새 폴더 또는 비어 있는 폴더여야 합니다. 결과의 `artifacts`는 이 폴더 기준 상대 경로이며,
TypeScript 호출부는 이를 Backend의 artifact root 기준으로 바꿉니다.
필요하면 `port`, `health_path`, `health_timeout`을 요청에 추가합니다. 기본은 8080, `/healthz`, 30초입니다.

`test_result.json` 변환은 류진님 adapter CLI가 맡습니다. 끝까지 실행된 불일치를 `status=succeeded`,
`summary.test_passed=false`로 구분해서 정책이 판단할 수 있게 넘깁니다. 시험 중단·다른 digest·다른 커밋은
단계 실패입니다. 이 호출부를 Backend에 등록하거나 DB 구조·배포 worker를 바꾸지는 않았습니다.

## 수정안 검토

```sh
python -m premortem repair-build \
  --build-manifest <빌드폴더>/build_manifest.json \
  --record <기록폴더>/session.jsonl --noise <기록폴더>/session.noise.json \
  --name guestbook --out-dir <새수정검토폴더> --allow-edit app.py \
  --ai live --plan <정책폴더>/plan.json --after 10 --json
```

실제 호출에는 `ANTHROPIC_API_KEY`, `PREMORTEM_LLM_MODEL`, Anthropic SDK가 필요합니다.
이번 확인에는 `claude-sonnet-5-5`와 Anthropic SDK 1.11.0을 썼습니다. 키는 실행 환경으로만 전달하고
파일에 저장하지 않습니다. 반복 실행은 저장된 `analysis.json`을 `--ai recorded --analysis-file`로 넘깁니다.
키나 모델이 없으면 호출하지 않았다는 오류를 남기고 종료합니다. 예시 응답으로 자동 대체하지 않습니다.
`--ai json-file --analysis-file <분석.json>`은 사람이 준비한 응답으로, `--ai recorded`는 저장된 실제 호출의
응답으로 동작합니다. 실행 결과에 각각의 방식을 표시합니다. `--allow-edit`는 파일마다 반복합니다.

정책 결과를 주면 공용 Plan 스키마와 run_id·digest·소스 커밋을 검사하고 `requires`를 AI 입력에 넣습니다.
인프라·정책·테스트 기준은 수정 대상에서 제외합니다. 검사한 수정안은 소스 복사본에만 넣고, 새 로컬
이미지로 같은 기록·노이즈·조건을 다시 실행합니다. 결과와 diff는 `repair_summary.json`과 `review.md`에서
봅니다. 재검증을 통과해도 `awaiting_human_review`이며 원본 앱은 바꾸지 않습니다.
수정 이미지를 레지스트리에 올리거나 정책을 다시 평가하는 단계는 이 명령에 포함하지 않습니다.
