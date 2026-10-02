# parity — 기록한 요청을 운영 조건 아래서 다시 재생해 보는 도구 (윤선, 주영)

> 모든 명령은 이 `parity/` 폴더에서 실행합니다. 검증 대상 방명록 앱은 레포의 `sample-app/`에 있습니다.

1. 실제 사용 흐름을 **기록 프록시**로 녹화한다. 요청·응답 한 쌍씩 JSONL 파일로 남기며, 비밀값은 가려서 저장한다.
2. 컨테이너를 새로 만들어 같은 요청을 **재생**한다. `none`(조건 없음), `restart`(재시작), `replace`(컨테이너 교체) 조건에서 응답이 기록과 같은지 비교한다.
3. 결과를 JSON 한 파일로 낸다: 조건별 일치 수, 불일치 목록, 그리고 원인 후보가 되는 **사실**(컨테이너 안의 sqlite 파일, 업로드 폴더 등).

회의에서 정한 기본 연결, 오류 처리, 교체 시험은 [MEETING.md](MEETING.md)에 있습니다.
이전 어댑터 실험 및 원본 인계 파일 제안은 [INTEGRATION.md](INTEGRATION.md)에 보존합니다.
기본 결과 JSON의 최상위 키와 타입은 유지하며, 실행 상태·해시는 별도 진단 파일에 저장합니다.
커밋된 앱을 레지스트리에 빌드·업로드하고 index digest를 기록하는 방법은
[premortem의 레지스트리 빌드](premortem/README.md#레지스트리-빌드)에 있습니다.

---

## 설치·실행

필요한 것: **Python 3.9 이상**, **Docker**(데몬 실행 중. `verify`만 쓸 때는 필요 없음). parity 기록·재생은 파이썬 외부 패키지를 쓰지 않습니다. `premortem`의 AI 수정 기능은 AI 출력 형식 검사에 jsonschema가 필요하므로 `pip install -r requirements.txt`로 설치합니다(없으면 AI 출력을 거부합니다).

```bash
# 기존 2조건 데모 (빌드 → 실행 → 기록 → 노이즈 탐지 → none/restart → 요약)
bash scripts/demo.sh                                            # macOS / Linux / Git Bash
powershell -ExecutionPolicy Bypass -File scripts\demo.ps1       # Windows
```

회의에서 정한 3조건 연결과 반복 실행을 확인하려면 별도 스크립트를 사용합니다.

```text
python scripts/demo_meeting.py
```

이 스크립트의 기존 실측은 두 회차 모두 `none: 20/20, restart: 14/20, replace: 13/20`입니다.
`demo.sh`·`demo.ps1`의 2조건 결과와 구분합니다. 실행 범위와 원본은 [MEETING.md](MEETING.md)에 있습니다.
기존 두 스크립트는 `none,restart`를 명시하는 개별 데모이며 **Policy 제출용 결과가 아닙니다**.

> ⚠️ 데모와 `noise`/`test` 명령은 `--container`로 지정한 컨테이너를 **지우고 다시 만듭니다**(`docker rm -f` → `docker run`). 운영 중인 컨테이너를 지정하면 안 됩니다.

명령을 하나씩 실행하는 방법:

```bash
docker build -t guestbook:1 ../sample-app
docker run -d --name guestbook -p 8080:8080 guestbook:1

# 1) 기록: 프록시(:8081)를 띄우고, -- 뒤 명령이 끝나면 기록도 끝난다
python -m parity record --target http://localhost:8080 --out records/session.jsonl \
  -- python scripts/simulate_usage.py --base http://127.0.0.1:8081

# 2) 노이즈 탐지: 초기 상태에서 2번 재생해 "재생할 때마다" 달라지는 필드를 찾는다 → records/session.noise.json
python -m parity noise --record records/session.jsonl --target http://localhost:8080 --container guestbook

# 3) test: 3조건 재생 → result.json + result.diagnostics.json
python -m parity test --record records/session.jsonl --target http://localhost:8080 \
  --container guestbook --conditions none,restart,replace --restart-after 10 --out result.json

# 이 샘플의 기대 요약: "none: 20/20, restart: 14/20, replace: 13/20, 불일치 13건"
python -m parity summary result.json
```

`test`에서 `--conditions`를 생략하면 **`none,restart,replace` 세 조건을 모두 실행**합니다.
주영님이 호출하는 파이프라인에서도 세 조건을 명시하기로 했습니다. 로컬 개별 검사에서는
`--conditions none` 같은 부분 선택이 가능하지만, **Policy에 제출할 결과는 세 조건 모두 필요**합니다.
회의 데모는 계속 세 조건을 명시하며, 기존 실측은 이번 기본값 변경 후 재실행 결과가 아닙니다.

재시작·교체 지점 고르기 (`test`의 옵션, 요청 번호는 1부터이며 두 조건에 같은 옵션 적용):

| 옵션 | 동작 |
|---|---|
| (없음) | 가운데에서 한 번 조건 적용 (요청이 20개면 10번 뒤) |
| `--restart-after 3,7` | 3번, 7번 요청 뒤에 조건 적용 |
| `--restart-every` | 모든 요청 사이에 조건 적용 (20개 요청이면 1~19번 뒤) |

`restart`는 기존 컨테이너를 재시작하고, `replace`는 같은 이미지·이름·고정 포트로 컨테이너를 새로 만듭니다.
그 뒤 `/healthz`가 200을 돌려줄 때까지 최대 30초 기다립니다(`--health-path`, `--health-timeout`으로 변경).
준비나 재생이 중단되면 `passed=false`와 `replay[].error`를 남기고 종료 코드 2로 끝납니다.
마지막 요청 뒤나 기록 범위 밖의 장애 지점, 장애를 적용할 수 없는 1개 요청 기록은 `test`에서 거부합니다.

### 배포 후 확인: `verify` (Docker 조작 없음, http/https)

배포된 대상에 기록한 요청을 **그대로 보내기만** 하고 비교합니다. 컨테이너를 재생성·재시작하지 않고, `facts`도 모으지 않습니다.

```bash
python -m parity verify --record records/session.jsonl --target https://guestbook.example.com \
  --allow-writes --out verify.json
```

- **대상 상태를 초기화하지 않습니다.** 기록을 시작했을 때와 같은 초기 상태(예: 방금 배포한 빈 환경)에서만 결과가 의미 있습니다.
- 기록에 `POST`/`PUT`/`PATCH`/`DELETE`가 있으면 `--allow-writes` 없이는 **실행을 거부**합니다(종료 코드 2). 배포 대상의 실제 데이터가 바뀌기 때문입니다. `GET`/`HEAD`/`OPTIONS`만 있는 기록은 옵션이 필요 없습니다.
- https 인증서는 **항상 검증**합니다. 사설 CA를 쓰면 `--cafile ca.pem`을 줍니다(`SSL_CERT_FILE` 환경변수도 동작함). 검증을 끄는 옵션은 없습니다.
- 인증이 필요한 대상이면 `--header "Authorization: Bearer $TOKEN"`으로 넣습니다. 기록 파일의 인증 헤더는 가려져 있어서 재생에 쓸 수 없습니다(아래 "비밀값 처리" 참고).
- 노이즈 규칙은 `test`와 같은 파일(`<기록이름>.noise.json`)을 씁니다. 노이즈 탐지는 초기화가 가능한 환경(Docker)에서 `noise` 명령으로 미리 만들어 둡니다.

**종료 코드**: `0` 전부 일치 · `1` 불일치 있음 · `2` 실행 오류(Docker 없음, 컨테이너 없음, 잘못된 옵션, verify 쓰기 거부 등). CI에서 그대로 쓸 수 있습니다.

테스트: `python -m unittest` (Docker 없이 돌아갑니다. 앱을 로컬 프로세스로, HTTPS 테스트는 자체 서명 인증서로 띄웁니다. HTTPS 테스트는 `openssl`이 없으면 건너뜁니다.)

---

## 출력 JSON 필드 (`test` → result.json, `verify` → verify.json)

형식의 기준은 [`mocks/test_result.json`](mocks/test_result.json)입니다. 키 순서와 타입이 같다는 것을 `tests/test_report.py`와 `tests/test_https_verify.py`가 검사합니다.
기존 2조건 데모 결과는 [`examples/demo_result.json`](examples/demo_result.json), 회의 3조건 실측은
[`examples/meeting_result.json`](examples/meeting_result.json)과 [진단 파일](examples/meeting_result.diagnostics.json)에 있습니다.
이 파일을 공유한 것과 정책·승인·서명까지 연결해 실행한 것은 구분합니다.
류진님의 [PR #12 보고](https://github.com/SoftBank-Hackathon-Hibiscus/hibiscus/pull/12)에서는
이 원본 샘플의 정규화와 정책 입력 두 경로를 확인했고, `block` 및 `fix_restart_failure`, `managed_db`,
`object_storage`를 받았다고 합니다. 이는 팀원이 공유한 검증 보고이며, 여기서 PR 소스를 직접 검토하거나
파이프라인 전체를 실행한 결과는 아닙니다. 세부 판정과 남은 연결은 [MEETING.md](MEETING.md)에 구분했습니다.

| 필드 | 타입 | 뜻 |
|---|---|---|
| `stage` | string | `"test"` 또는 `"verify"`. 어느 명령의 결과인지 표시 |
| `commit` | string | 아래 "commit 값의 의미" 참고. 조건을 만족하지 않으면 `"unknown"` |
| `image` | string | `test`: 검증한 컨테이너의 이미지 (예: `"guestbook:1"`). `verify`: 대상 이미지를 알 수 없으므로 항상 `"unknown"` |
| `passed` | bool | **모든 조건에서 모든 요청이 일치**해야 `true`. 재생이 중단된 조건이 있어도 `false` |
| `facts` | array | 컨테이너 안에 남은 상태 목록 (아래 표). **`verify`에서는 수집하지 않으므로 항상 `[]`** — "상태가 없다"는 뜻이 아님 |
| `replay` | array | 조건마다 하나씩: `{"condition", "total", "matched"}`. 재생이 중단되면 `"error"` 키가 추가됨. `verify`는 `none` 하나 |
| `mismatches` | array | 일치하지 않은 요청 하나당 하나 (아래 표) |

### commit 값의 의미

- `test`: 명령을 실행한 폴더 아래 작업 트리가 **HEAD와 정확히 같을 때만**(수정·스테이징·미추적 파일이 하나도 없을 때) `git rev-parse --short HEAD` 값을 씁니다. 하나라도 있거나 git 저장소가 아니면 `"unknown"`입니다. 현재 실행 경로는 이 값만 결과에 담으며, `unknown`의 상세 이유를 로그로 출력하지 않습니다.
- `verify`: 항상 `"unknown"`입니다. 원격 대상이 어떤 코드로 배포됐는지 이 도구가 확인할 방법이 없기 때문입니다.
- **한계:** 깨끗한 커밋이 기록돼도, 그것은 "실행 시점의 로컬 도구 코드가 그 커밋과 같았다"는 뜻일 뿐입니다. **검사한 이미지가 그 커밋으로 빌드됐다는 증명은 아닙니다.** 팀 공통 식별자로는 파이프라인의 `run_id`, 앱 소스 Git SHA, 레지스트리 digest를 사용하기로 했습니다. 주영님이 빌드·최초 실행·digest 기록을 맡으며, 실제 값을 전달하는 연결은 아직 확인이 필요합니다. 진단 파일의 `registry_digest`·`source_revision`은 현재 `null`입니다.

### `facts[]` 항목

`docker diff`로 이미지와 비교해 컨테이너가 새로 쓴 파일을 분류한 것입니다.

| 필드 | 뜻 |
|---|---|
| `kind` | `sqlite`(파일 헤더가 `SQLite format 3`) · `local_upload`(uploads/upload/media 폴더, 폴더당 1개) · `local_file`(그 밖의 파일) |
| `path` | 컨테이너 안의 경로 |
| `storage` | 현재는 항상 `container_layer`. `docker restart`로는 남지만, 컨테이너를 **다시 만들면**(재배포, 스케일아웃한 새 인스턴스) 사라지거나 인스턴스끼리 공유되지 않는다는 뜻 |
| `evidence` | 판단 근거 (사람이 읽는 용도) |

### `mismatches[]` 항목

| 필드 | 뜻 |
|---|---|
| `condition` | 어느 조건에서 어긋났는지 (`none`/`restart`/`replace`) |
| `index` | 기록 파일의 요청 번호 (1부터) |
| `request` | `"GET /posts"` 형태 (쿼리의 비밀값은 가려짐) |
| `expected` / `actual` | 기록 당시 응답 / 재생 응답. `"상태코드 본문"` 한 줄이며, 200자가 넘으면 `…`로 자름. JSON 본문의 비밀 필드는 가려서 씀. 연결 실패면 `0 <connection error: …>` |
| `related_fact` | 관련 있어 보이는 사실의 `path`. 없으면 `null`. **원인을 증명한 것이 아니라 "여기부터 보라"는 힌트** |

`related_fact` 규칙 (`parity/report.py`의 `RELATED_RULES`):

| 요청 경로 | 연결하는 사실 |
|---|---|
| `/posts`, `/posts/...` | `sqlite` |
| `/uploads`, `/uploads/...` | `local_upload` |
| `/me`, `/login`, `/logout` | `session` (세션은 메모리에 있어 사실로 잡히지 않으므로 보통 `null`) |
| 그 밖의 경로 | `null` |

---

## 무엇을 "일치"로 보나

- **상태코드**와 **본문**을 비교합니다. 본문이 JSON이면 필드 단위로 펼쳐 비교합니다 (`body[0].author` 등). 헤더는 비교하지 않습니다.
- 노이즈 적용 규칙에 있는 필드는 **값만 달라졌을 때** 무시합니다. 예: `body[*].created_at` → 목록의 모든 글의 생성 시각.
- 다음 차이는 노이즈 규칙에 있어도 **절대 무시하지 않습니다** (`parity/compare.py`의 `can_ignore`). 규칙 파일을 손으로 고쳐도 마찬가지입니다.
  - 상태코드가 다름
  - 연결 실패, 또는 재생되지 못한 요청
  - 필드가 한쪽에만 있음 (필수 필드 누락)
  - 값의 타입이 바뀜 (예: 문자열 → `null`). 정수와 실수는 같은 숫자 타입으로 봅니다.
- 조건마다 재생 전에 컨테이너를 **새로 만들어** 기록 시작 시점과 같은 초기 상태에서 출발합니다 (`verify` 제외).

### 노이즈 판정 (`noise` 명령)

노이즈 = **재생할 때마다** 달라지는 값입니다. "기록과 다른 값"이 아닙니다. 기록과 다른 필드는 모두 **후보(candidates)**가 되고, 판정을 통과한 것만 **적용 규칙(rules)**이 됩니다. `test`/`verify`는 `rules`만 읽습니다.

| reason | 결정 | 뜻 |
|---|---|---|
| `varies_between_runs` | applied | 재생끼리도 값이 서로 다름 → 노이즈 |
| `consistent_difference` | rejected | 재생끼리는 같고 기록과만 다름 → 노이즈가 아니라 **실제 차이** |
| `status_code` | rejected | 상태코드는 자동 제외 금지 |
| `connection_error` | rejected | 재생 중 연결 실패/미실행 (필드는 `"*"`) |
| `missing_field` | rejected | 필드가 기록이나 재생 중 한쪽에 없음 |
| `type_changed` | rejected | 값의 타입이 바뀜 |
| `whole_body` | rejected | 본문 전체(JSON이 아닌 글자 본문 등)가 한 덩어리로 달라짐 → 빼면 검증할 것이 없음 |

예) 기록은 200인데 두 재생이 모두 500이면 `status`는 `status_code`로, 본문 필드는 `missing_field`로 거부됩니다. 적용 규칙이 없으므로 `test`에서 불일치로 잡힙니다(`tests/test_regression_noise.py`).

`--runs`는 2 이상이어야 합니다. 재생끼리 비교해야 노이즈와 실제 차이를 구분할 수 있기 때문입니다.

```json
{"runs": 2,
 "rules":      [{"index": 4, "request": "POST /posts", "fields": ["body.created_at"]}],
 "candidates": [{"index": 4, "request": "POST /posts", "field": "body.created_at",
                 "decision": "applied", "reason": "varies_between_runs"}]}
```

---

## 비밀값 처리

프록시는 원본을 **그대로 전달**하고, 파일에는 **가린 사본**만 씁니다(`parity/record.py`의 `to_stored`, 규칙은 `parity/redact.py`).

| 위치 | 가리는 것 | 예 |
|---|---|---|
| 헤더 | `Authorization`, `Proxy-Authorization`, `X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token` 등 이름이 비밀값인 헤더 | `Authorization: <redacted>` |
| `Cookie` | 모든 쿠키 값 (이름은 남김) | `sid=<redacted>; theme=<redacted>` |
| `Set-Cookie` | 값만 (속성은 남김, 삭제용 빈 값은 그대로) | `sid=<redacted>; Path=/; HttpOnly` |
| JSON·form 본문 | `password`, `token`, `secret`, `api_key`, `access_token` 등의 필드 값 | `{"password": "<redacted>"}` |
| 쿼리 | 위와 같은 이름의 파라미터 값 | `?access_token=<redacted>&page=2` |

이름으로 판별합니다. 짧은 이름(`auth`, `sid`, `pwd`, `otp`)은 정확히 일치할 때만 가리므로 `author` 같은 필드는 가리지 않습니다.

재생할 때:
- **쿠키**: 기록의 값은 버리고, 재생 중 서버가 새로 준 `Set-Cookie`를 다음 요청에 붙입니다. 로그인 유지와 로그아웃이 그대로 재현됩니다(`tests/test_record_replay.py`).
- **가려진 헤더**(`Authorization` 등): 보내지 않고 경고합니다. 필요하면 `--header`로 넣습니다.
- **기록에서 가려진 응답 필드**: 값을 알 수 없으므로 "실제 응답에도 그 필드가 있는지"만 확인합니다.
- **결과 JSON의 `actual`**: 재생 응답의 JSON 비밀 필드를 가려서 씁니다.

---

## 데모 앱(guestbook)과 기대 결과

`../sample-app/app.py`에는 운영 환경에서 흔한 결함 3개를 **일부러** 넣었습니다. `TLS_CERT`/`TLS_KEY` 환경변수를 주면 HTTPS로 뜹니다(`verify` 테스트용).

| 결함 | `restart` | `replace` | 관련 근거 |
|---|---|---|---|
| 세션을 프로세스 메모리에 저장 | 로그인이 풀림 → `/me` 401 | 동일하게 로그인 풀림 | `related_fact: null` |
| 시작할 때마다 `DROP TABLE` | 글 목록이 비워짐 → `/posts` | 동일하게 글 목록 비워짐 | `/app/data/data.db` |
| 업로드를 컨테이너 내부에 저장 | 파일 유지, 응답 일치 | 16번 `GET /uploads`에서 `cat.png` 유실 검출 | `local_upload` 사실과 원본 불일치 |

기존 2조건 데모 실측: `none: 20/20, restart: 14/20, 불일치 6건`.
`--restart-after 3,7` → 14/20, `--restart-every` → 10/20은 1차 구현 당시 Docker 실측이며 이후 수정 전체에 대한 재실행 결과는 아닙니다.

회의 데모는 10번 요청 뒤 조건을 적용했고, 두 회차 모두 `none: 20/20, restart: 14/20, replace: 13/20`을 확인했습니다.
불일치 13건은 restart 6건 + replace 7건입니다. 결함을 의도대로 검출했으므로 앱 판정은 `passed=false`입니다.
수정 앱의 통과나 AI 수정·정책·서명·Cloud Run 연결을 검증한 결과는 아닙니다.

---

## 알려진 한계

- **기록한 요청 범위까지만 검증합니다.** 기록에 없는 경로나 입력, 다른 사용자 흐름은 검사되지 않습니다.
- **조건은 `none`, `restart`, `replace`를 지원합니다.** 재시작만으로 드러나지 않던 업로드 유실은 `replace`로 검사합니다. 다중 인스턴스 분산이나 클라우드의 유휴 CPU 제한은 현재 조건에 포함되지 않습니다.
- **`commit`은 이미지의 출처를 증명하지 않습니다.** 위 "commit 값의 의미" 참고. 미추적·수정 파일이 있으면 `"unknown"`, `verify`는 항상 `"unknown"`입니다.
- **`verify`는 대상의 상태를 초기화하지 않습니다.** 이미 데이터가 있는 환경에서는 상태에 의존하는 응답(`GET /posts` 등)이 기록과 달라 불일치로 나옵니다. `facts`도 수집하지 않습니다.
- **비밀값은 이름 규칙으로만 가립니다.** JSON·form이 아닌 본문(HTML, 바이너리)이나, 비밀스럽지 않은 이름의 필드에 담긴 비밀값은 가리지 못합니다. 요청 본문·쿼리의 비밀값(예: 로그인 비밀번호)을 가리면 재생 때 원래와 다른 요청이 가므로 해당 요청은 불일치가 날 수 있습니다(경고 출력).
- **노이즈 판정은 보수적입니다.** 재생끼리 같은 값이 기록과만 다르면 실제 차이로 봅니다. 그래서 기록 환경과 재생 환경이 다르면(호스트명·버전 문자열 등) 불일치가 납니다. 매번 달라지는 HTML 본문(CSRF 토큰 등)은 자동으로 제외되지 않습니다. `test`는 `body`·`*`처럼 본문 전체를 제외하는 규칙을 거부합니다. `verify`의 기존 로더는 `body` 규칙에 경고만 하므로, 검출기가 만든 같은 규칙 파일을 사용하고 본문 전체를 수동으로 제외하지 않습니다.
- `related_fact`는 경로 이름 규칙으로 붙이는 힌트입니다. 규칙은 guestbook 경로에 맞춰져 있으므로 다른 앱에 쓰려면 `RELATED_RULES`를 고쳐야 합니다.
- `facts`는 `docker diff`에 보이는 파일만 찾습니다. 볼륨·tmpfs 안의 파일, 프로세스 메모리 상태(세션, 캐시)는 보이지 않습니다.
- 재생성은 샘플 앱과 기본 bridge 실행기 범위입니다. 실제 이미지 ID·이름·고정 TCP 포트, 환경변수, 명시적 `-v`·`--tmpfs`, 라벨, 기본 보안·리소스 제한, 사용자·작업 폴더·entrypoint·CMD를 지원 범위 안에서 유지합니다. 자동 포트, `--mount`, 익명 볼륨, 사용자 네트워크 등 지원하지 않는 설정은 삭제 전에 거부합니다. 외부 볼륨의 데이터는 초기화하지 않습니다. 자세한 범위는 [MEETING.md](MEETING.md)를 참고합니다.
- 요청은 한 번에 하나씩 순서대로 재생합니다. 동시 요청 때문에 생기는 문제는 재현하지 않습니다. `Transfer-Encoding: chunked` 요청 본문은 기록하지 못합니다.

---

## 폴더 구조

```
../sample-app/         검증 대상 guestbook 앱 (Dockerfile, app.py) — 레포의 sample-app/ 폴더
parity/
  __main__.py         CLI (record / noise / facts / test / verify / summary)
  record.py           1단계  기록 프록시(전달용 원본 / 저장용 사본 분리), 기록 파일 형식, http·https 전송
  redact.py                  비밀값 가리기 규칙
  replay.py           2단계  재생기 + 훅(ReplayHook), 쿠키 저장소, --header 주입
  compare.py          2단계  응답 비교 (필드 단위, 노이즈로도 무시 못 하는 차이)
  noise.py            2단계  노이즈 판정 (후보 → 적용 규칙)
  facts.py                   컨테이너 상태 사실 수집 (docker diff)
  conditions.py       3단계  조건: none, restart, replace (재생 훅으로 연결)
  execution.py        3단계  test 실행 경계, 기준·이미지 유지 확인, 실패 결과·진단 저장
  report.py           3단계  결과 JSON 생성, related_fact 규칙, commit 판정, 요약
  docker_ops.py              고정 설정 재생성, 실제 이미지 ID 확인, docker CLI 호출, /healthz 대기
  premortem_adapter.py       별도 환경 실행기 연결용 어댑터 (기본 test 경로와 구분)
  handoff.py                 원본 결과와 제공받은 식별정보 인계 (제안 형식)
mocks/test_result.json       결과 JSON 형식 기준
examples/demo_result.json    데모 실제 결과 (sample-app, none + restart)
examples/meeting_result.json 회의 데모 실제 결과 (none + restart + replace)
scripts/                     simulate_usage.py, 기존 demo.sh/demo.ps1, demo_meeting.py
tests/                       python -m unittest
```

## 결과를 읽는 방법
일치 수가 전체 요청 수보다 적으면 기록과 다른 응답이 있다는 뜻입니다. 의도적으로 결함을 넣은 샘플에서는 실패 판정이 정상적인 검출 결과일 수 있습니다.

## 기록 시작 실패와 조건별 비교 보기

기록 프록시는 포트와 대기 스레드를 먼저 준비한 뒤 출력 파일을 엽니다. 포트 충돌이나 스레드 시작 실패 때문에 기존 기록이 비워지는 것을 방지하고, 파일 열기에 실패하면 준비한 소켓과 대기 스레드를 정리합니다. 정상적으로 기록을 시작하면 기존처럼 같은 출력 파일을 새 기록으로 덮어쓰고, 요청마다 즉시 저장합니다. 기록 시작 이후의 디스크 장애나 강제 종료까지 원자적 저장을 보장하는 기능은 아닙니다.

`examples/summary_matrix_result.json`은 이전 방명록 데모에서 실측한 결과를 그대로 복사한 비교표 예시입니다. 이번 변경에서 Docker 데모를 새로 실행한 결과는 아닙니다.

기존 요약에 `--matrix`를 붙이면 같은 요청이 세 조건에서 어떻게 달라졌는지 표로 확인할 수 있습니다.

```text
python -m parity summary examples/summary_matrix_result.json --matrix
```

- 원본 결과를 읽어서 표시하며 Docker 실행, 앱 요청, 파일 수정, 통과·실패 재판정을 하지 않습니다.
- 조건별 불일치를 요청 번호로 묶습니다. 예시의 불일치 13건은 서로 다른 요청 7개이며, 교체 조건에서 추가된 요청은 16번입니다.
- 중단 조건은 관찰된 불일치만 표시합니다. 나머지 요청의 실행 여부는 파일만으로 알 수 없어 `확인불가`로 표시합니다.
- 조건이 빠졌거나 중단됐거나 전체 요청 수가 다르면 추가 불일치 번호를 추론하지 않습니다.
- 수치와 불일치 목록이 모순되거나 번호가 중복·범위 밖이면 표를 출력하지 않고 오류(종료 코드 2)로 끝납니다.
- 세부 기대·실제 응답은 기존 `summary` 명령에서 확인합니다. 저장될 때 잘린 응답을 복원하거나 관련 사실을 확정 원인으로 바꾸지는 않습니다.

`summary --matrix`의 종료 코드 0은 보고서 표시 성공이며, 검사 통과나 배포 허가를 뜻하지 않습니다. 기존 `result.json`, handoff와 Policy 계약은 바꾸지 않습니다.
