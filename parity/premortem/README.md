# premortem

parity 안에서 배포 환경 조건을 재현하고, AI 수정안을 같은 기록으로 다시 검사하는 부분입니다. (주영)

- replace: i번 요청의 응답을 받은 뒤 컨테이너를 같은 이미지로 새로 만들고 이어서 재생합니다. restart로는 안 잡히는 파일 유실을 봅니다.
- 바인딩 확인: 컨테이너 밖에서 응답이 없을 때 안에서 health를 따로 불러 보고 listen 주소를 확인해서, 127.0.0.1 바인딩 후보인지 판단합니다.
- AI 수정 후 재검증: AI 수정안을 검사해서 복사본에만 적용하고, 새 이미지로 같은 기록을 처음부터 다시 돌립니다. 원본은 사람이 확인한 뒤에만 바꿉니다.

## 지금 상태

- 윤선님 재생기(`parity/parity`)와는 아직 연결 전입니다. 지금은 `examples/premortem`의 샘플 전용 재생기로만 돌고, 결과에 reference라고 표시됩니다.
- AI는 키가 없어서 예시 응답(fixture)으로만 돌렸습니다. 실제 호출 코드는 들어 있습니다.
- 정책 입력(test_result)은 만들지 않습니다. 결과(env_report)와 증거를 넘기고, 변환은 류진님 변환기에서 합니다.

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
