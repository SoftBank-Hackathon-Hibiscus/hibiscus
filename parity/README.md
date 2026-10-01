# parity — 기록한 요청을 운영 조건 아래서 다시 재생해 보는 도구 (윤선, 주영)

> 모든 명령은 이 `parity/` 폴더에서 실행합니다. 검증 대상 방명록 앱은 레포의 `sample-app/`에 있습니다.

1. 실제 사용 흐름을 **기록 프록시**로 녹화한다. 요청·응답 한 쌍씩 JSONL 파일로 남기며, 비밀값은 가려서 저장한다.
2. 컨테이너를 새로 만들어 같은 요청을 **재생**한다. 이때 "요청 10번 뒤 `docker restart`" 같은 **조건**을 끼워 넣고, 응답이 기록과 같은지 비교한다.
3. 결과를 JSON 한 파일로 낸다: 조건별 일치 수, 불일치 목록, 그리고 원인 후보가 되는 **사실**(컨테이너 안의 sqlite 파일, 업로드 폴더 등).

환경 실행기 연결, 컨테이너 교체 시험, 정책 담당자에게 원본 결과를 전달하는 방법은
[INTEGRATION.md](INTEGRATION.md)에 있습니다. 기존 `test`/`verify` 명령과 결과 JSON 형식은 그대로입니다.

---

## 설치·실행

필요한 것: **Python 3.9 이상**, **Docker**(데몬 실행 중. `verify`만 쓸 때는 필요 없음). parity 기록·재생은 파이썬 외부 패키지를 쓰지 않습니다. `premortem`의 AI 수정 기능은 AI 출력 형식 검사에 jsonschema가 필요하므로 `pip install -r requirements.txt`로 설치합니다(없으면 AI 출력을 거부합니다).

```bash
# 데모 한 번에 실행 (빌드 → 실행 → 기록 → 노이즈 탐지 → test → 요약)
bash scripts/demo.sh                                            # macOS / Linux / Git Bash
powershell -ExecutionPolicy Bypass -File scripts\demo.ps1       # Windows
```

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

# 3) test: 조건별 재생 → result.json
python -m parity test --record records/session.jsonl --target http://localhost:8080 \
  --container guestbook --conditions none,restart --out result.json

# 결과 요약: "none: 20/20, restart: 14/20, 불일치 6건" + 불일치 목록
python -m parity summary result.json
```

재시작 지점 고르기 (`test`의 옵션, 요청 번호는 1부터):

| 옵션 | 동작 |
|---|---|
| (없음) | 가운데에서 한 번 재시작 (요청이 20개면 10번 뒤) |
| `--restart-after 3,7` | 3번, 7번 요청 뒤에 재시작 |
| `--restart-every` | 모든 요청 사이에 재시작 (1~19번 뒤) |

재시작한 뒤에는 `/healthz`가 200을 돌려줄 때까지 최대 30초 기다립니다(`--health-path`, `--health-timeout`으로 바꿀 수 있음). 30초 안에 살아나지 않으면 그 조건의 재생을 멈추고 `replay` 항목에 `error`를 남깁니다.

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
데모를 실제로 돌린 결과는 [`examples/demo_result.json`](examples/demo_result.json)에 있습니다 (다른 파트 연동 확인용).

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

- `test`: 명령을 실행한 폴더 아래 작업 트리가 **HEAD와 정확히 같을 때만**(수정·스테이징·미추적 파일이 하나도 없을 때) `git rev-parse --short HEAD` 값을 씁니다. 하나라도 있으면 `"unknown"`이며, 이유는 실행 로그에 `[test] commit=unknown: 미추적 파일 N개 …`처럼 남습니다. git 저장소가 아니어도 `"unknown"`입니다.
- `verify`: 항상 `"unknown"`입니다. 원격 대상이 어떤 코드로 배포됐는지 이 도구가 확인할 방법이 없기 때문입니다.
- **한계:** 깨끗한 커밋이 기록돼도, 그것은 "실행 시점의 로컬 코드가 그 커밋과 같았다"는 뜻일 뿐입니다. **검사한 이미지가 그 커밋으로 빌드됐다는 증명은 아닙니다.** 이미지를 먼저 빌드하고 코드를 바꾼 뒤 커밋했다면 둘은 다릅니다. 이미지와 코드를 묶으려면 빌드할 때 이미지에 리비전 라벨을 넣고 그 값을 읽는 방식이 필요합니다(아직 구현하지 않음).

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
| `condition` | 어느 조건에서 어긋났는지 (`none`/`restart`) |
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

| 결함 | `restart` 조건에서 | 데모 결과 |
|---|---|---|
| 세션을 프로세스 메모리에 저장 | 로그인이 풀린다 → `/me` 401 | 불일치, `related_fact: null` |
| 시작할 때마다 `DROP TABLE` | 글 목록이 비워진다 → `/posts` | 불일치, `related_fact: /app/data/data.db` |
| 업로드를 컨테이너 내부에 저장 | **드러나지 않음** (restart는 파일을 지우지 않음) | 일치, `facts`에만 `local_upload`로 보고됨 |

실측 (가운데 한 번 재시작): `none: 20/20, restart: 14/20, 불일치 6건`
(`--restart-after 3,7` → 14/20, `--restart-every` → 10/20)

---

## 알려진 한계

- **기록한 요청 범위까지만 검증합니다.** 기록에 없는 경로나 입력, 다른 사용자 흐름은 검사되지 않습니다.
- **조건은 현재 재시작(`docker restart`)만 지원합니다.** `docker restart`는 컨테이너의 파일을 지우지 않으므로, 업로드 파일처럼 "컨테이너 안에 저장된 파일" 문제는 재생 결과로는 드러나지 않고 `facts`로만 보고됩니다.
- **`commit`은 이미지의 출처를 증명하지 않습니다.** 위 "commit 값의 의미" 참고. 미추적·수정 파일이 있으면 `"unknown"`, `verify`는 항상 `"unknown"`입니다.
- **`verify`는 대상의 상태를 초기화하지 않습니다.** 이미 데이터가 있는 환경에서는 상태에 의존하는 응답(`GET /posts` 등)이 기록과 달라 불일치로 나옵니다. `facts`도 수집하지 않습니다.
- **비밀값은 이름 규칙으로만 가립니다.** JSON·form이 아닌 본문(HTML, 바이너리)이나, 비밀스럽지 않은 이름의 필드에 담긴 비밀값은 가리지 못합니다. 요청 본문·쿼리의 비밀값(예: 로그인 비밀번호)을 가리면 재생 때 원래와 다른 요청이 가므로 해당 요청은 불일치가 날 수 있습니다(경고 출력).
- **노이즈 판정은 보수적입니다.** 재생끼리 같은 값이 기록과만 다르면 실제 차이로 봅니다. 그래서 기록 환경과 재생 환경이 다르면(호스트명·버전 문자열 등) 불일치가 납니다. 매번 달라지는 HTML 본문(CSRF 토큰 등)은 자동으로 제외되지 않습니다. 필요하면 사람이 `rules`에 `"body"`를 넣을 수 있고, 그러면 그 요청은 상태코드만 검증됩니다(로드할 때 경고).
- `related_fact`는 경로 이름 규칙으로 붙이는 힌트입니다. 규칙은 guestbook 경로에 맞춰져 있으므로 다른 앱에 쓰려면 `RELATED_RULES`를 고쳐야 합니다.
- `facts`는 `docker diff`에 보이는 파일만 찾습니다. 볼륨·tmpfs 안의 파일, 프로세스 메모리 상태(세션, 캐시)는 보이지 않습니다.
- 컨테이너를 다시 만들 때는 이미지, 이름, `-p`, `-e`, `-v`, `--tmpfs`, `--network`, CMD만 복원합니다. `--mount`, `--entrypoint`, 리소스 제한 등은 빠지고, 네임드 볼륨은 내용이 남아 있어 초기 상태가 아닐 수 있습니다.
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
  conditions.py       3단계  조건: none, restart (재생 훅으로 연결)
  report.py           3단계  결과 JSON 생성, related_fact 규칙, commit 판정, 요약
  docker_ops.py              docker CLI 호출, /healthz 대기
mocks/test_result.json       결과 JSON 형식 기준
examples/demo_result.json    데모 실제 결과 (sample-app, none + restart)
scripts/                     simulate_usage.py, demo.sh, demo.ps1
tests/                       python -m unittest
```
