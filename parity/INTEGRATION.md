# 기록·재생 모듈 연결 안내

> **현재 기본 연결은 [MEETING.md](MEETING.md)를 따릅니다.** 회의 합의 및 PR #8에 따라
> 주영님이 빌드·최초 실행한 컨테이너를 윤선님의 `test`가 검사하고,
> `conditions.py`의 `replace`가 `docker_ops.recreate`를 호출합니다.
> 아래 1~3절은 PR #6에서 수행한 **별도 어댑터 실험 기록**입니다.
> 주소를 바꾸는 어댑터나 외부 `ConditionRunner`는 현재 기본 CLI 연결의 필수 조건이 아닙니다.

기본 경로의 역할은 확정됐습니다. 주영님이 빌드·최초 실행·AI 수정 후 새 이미지 실행·digest 기록을 맡고,
윤선님은 같은 기록으로 `test`를 실행합니다. 재생성은 윤선님의 `recreate`, Policy 앞 변환기는 류진님 담당입니다.
이 역할 합의와 실제 AI 수정·정책·서명까지의 연결 실행 완료는 구분합니다. 회의 안건 8개의 현황은
[MEETING.md](MEETING.md)의 「테스트 → 정책: 회의 안건 8개 현황」에 정리했습니다.

이 문서는 2026-10-01 연결 작업의 구현 범위와 실제 실행 결과를 설명합니다.
기존 원본 결과는 [examples/demo_result.json](examples/demo_result.json)입니다.
그 파일의 `passed: false`는 결함을 넣은 방명록을 차단한 정상 판정입니다.

## 1. 이번에 연결한 부분

```text
기록 JSONL + 노이즈 규칙
          ↓
premortem ConditionRunner → ParityReplayPort → parity 재생·비교
   컨테이너 생성/교체 담당     연결 담당           요청·응답 담당
          ↑                        │
          └── 응답 비교 완료 후 훅 ──┘
```

환경 실행기가 요청 직전에 현재 주소를 알려줍니다. 재생기는 응답을 비교한 뒤
요청 사이의 훅을 호출합니다. 그래서 컨테이너 교체로 포트가 바뀌어도 다음 요청부터
새 주소를 사용합니다. 쿠키는 같은 재생 흐름 안에서 이어집니다.

- 환경 실행기가 컨테이너 생성·초기화·재시작·교체·정리를 소유합니다.
- 어댑터는 Docker를 실행하지 않습니다. `noise`/`test` CLI를 안쪽에서 다시 호출하지 않습니다.
- 중단되면 이미 비교한 결과를 보존하고 `ReplayHookError.partial`로 돌려줍니다.
- 마지막 요청 뒤에는 새 환경 훅을 호출하지 않습니다. 기존 `Hook.after_request` 동작은 유지합니다.
- 기록과 노이즈 파일은 실행 중 바뀌면 안 됩니다. 변경을 발견하면 오류로 처리합니다.
- 사실 수집을 하지 않은 어댑터의 `facts`는 `None`입니다. 빈 목록을 사실 부재로 해석하면 안 됩니다.

## 2. 환경 모듈에서 호출하기

검증한 상대 코드는 PR #4의 커밋 `7bd00d84b005b9b3c72e9176748ccdd91a1492a8`입니다.
이 PR은 그 코드를 복사하거나 수정하지 않습니다. `premortem`이 Python 경로에 있을 때만
선택적으로 사용합니다. 일반 parity 명령에는 새 의존성이 생기지 않습니다.

```python
from parity.premortem_adapter import ParityReplayPort

port = ParityReplayPort(request_timeout=5.0, max_requests=200)
outcome = port.replay(
    session_path=session_path,
    noise_path=noise_path,
    target_for_request=lambda index: current_target_url,
    after_response=change_environment_if_needed,
    runtime_secrets={},
)
```

`ConditionRunner(..., replay_port=port, ...)`로도 직접 주입할 수 있습니다.
실험 당시 상대 PR의 기본 loader는 stub이었고, 데모에서는 직접 주입했습니다.
현재 회의 기본 경로는 `parity test`이므로 그 loader를 연결해야만 기본 경로가 완성되는 것은 아닙니다.
별도 `ConditionRunner` 경로를 채택할 때에만 loader 연결을 함께 확인합니다.

입력은 parity의 JSONL과 `noise.rules` 형식입니다. 요청 번호는 **1부터 연속**이어야 합니다.
상대 PR의 reference 샘플 기록은 다른 양식이라 그대로 넣을 수 없습니다.
상태코드·연결 실패·필드 누락·타입 변경을 노이즈로 무시하지 않으며, 본문 전체를 제외하는
`body` 규칙은 어댑터에서 거부합니다. 원래 검출기로 만든 규칙을 사용하세요.

`runtime_secrets`는 공통 매핑 규칙이 정해지지 않아 현재 `{}`만 받습니다.
비어 있지 않으면 오류로 끝냅니다. 로그인 과정에서 새로 발급되는 쿠키는 재생기가 처리합니다.
대상 주소 콜백은 같은 앱의 신뢰하는 실행 환경을 반환해야 합니다.

## 3. 실제 Docker 연결 데모

명령은 팀 레포의 `parity/`에서 실행합니다. `<상대 parity 폴더>`는 `premortem/`이 들어 있는
신뢰하는 팀 코드의 폴더입니다. 병합되어 같은 폴더에 있다면 `.`을 넣으면 됩니다.

```text
python scripts/demo_integration.py --premortem-root "<상대 parity 폴더>"
```

이 스크립트는 방명록을 한 번 빌드하고, 새로운 컨테이너에서 기록 → 두 번 기준 재생 →
none/restart/replace를 수행합니다. 10번 요청 뒤에 조건을 적용합니다.
임의의 실행 ID와 자동 할당 포트를 사용하고, 생성한 컨테이너만 정리합니다.
빌드한 데모 이미지는 남겨 둡니다. 결과는 `records/integration/<run_id>/`에 저장하며 Git에서는 제외합니다.

2026-10-01 실제 Docker 실행 결과:

| 조건 | 실행 | 일치 | 불일치 요청 번호 |
|---|---:|---:|---|
| none | 20/20 | 20/20 | 없음 |
| restart | 20/20 | 14/20 | 11, 12, 13, 14, 17, 20 |
| replace | 20/20 | 13/20 | 11, 12, 13, 14, **16**, 17, 20 |

16번은 업로드 목록 조회입니다. 교체 전 저장한 `cat.png`가 사라진 차이를 추가로 검출했습니다.
DB 문제는 샘플 앱이 시작할 때 테이블을 지우도록 만든 결함이고, 세션은 메모리에 있습니다.
`docker restart`가 DB 파일 자체를 지웠다는 뜻은 아닙니다.

실측 결과 사본: [examples/premortem_integration_result.json](examples/premortem_integration_result.json).
이 파일은 연결 데모용 결과이며 기존 `result.json`이나 공통 Policy 입력 양식이 아닙니다.
`facts`는 기록용 컨테이너를 제거하기 전에 수집한 원본이며, 조건별 컨테이너 관측은 `evidence.jsonl`에 따로 저장합니다.

`passed=false`는 앱 검사 실패, `demo_expectations_met=true`는 의도한 결함을 정확히 발견한 데모 성공입니다.
스크립트 종료 코드 0은 **데모 검증 성공**입니다. 이를 배포 허가로 쓰면 안 됩니다.
같은 **로컬 이미지 ID**로 시험했으며 레지스트리 digest 검증, AI 수정, 정책·서명·클라우드 배포는 실행하지 않았습니다.

## 4. 정책 담당자에게 전달할 원본과 실행 정보

원본 `facts`는 `{kind, path, storage, evidence}` 목록으로 유지합니다.
`facts.db`, `facts.writes_local_file` 등 정책 전용 필드로의 변환은 류진님이 Policy 앞 변환기에서 처리합니다.
기본 `result.json`의 키·타입·순서를 바꾸지 않았습니다.
변환기는 윤선님의 result와 주영님의 env_report를 입력으로 연결하며 원본 facts·evidence를 보존합니다.
주영님의 `env_report`·`evidence`·`handoff_bundle`도 보존하기로 했습니다. 실제 env_report 예시는 아직 공유 약속 단계입니다.
윤선님이 이 세 파일을 자동 병합하는 새 계약이나 변환기를 별도로 만들기로 한 것은 아닙니다.

별도 인계 파일 생성 도구를 추가했습니다. **팀에서 합의한 공통 계약이 아니라 제안 형식**입니다.
정책 CLI에 바로 넣지 말고, 원본과 메타데이터를 보존하는 입력 후보로 검토합니다.

```text
python -m parity.handoff --result result.json --run-id <실행ID> --app guestbook --source-revision <앱의커밋SHA> --digest sha256:<레지스트리digest> --out records/handoff.json
```

| 필드 | 뜻 |
|---|---|
| `metadata.run_id` | 한 번의 실행을 구분하는 ID. 파이프라인에서 받아 전달 |
| `metadata.app` | 검증할 앱 이름 |
| `metadata.source_revision` | **앱**의 Git commit SHA. 도구 저장소의 HEAD에서 추측하지 않음. 전체 SHA 권장 |
| `metadata.digest` | 주영님이 빌드 결과로 기록·제공하는 레지스트리 digest. 로컬 image ID와 구분 |
| `result` | 원본 결과 전체. facts·evidence·실패 여부 그대로 보존 |
| `result_artifact.sha256` | 읽은 원본 파일 바이트의 해시 |
| `result_sha256` | 키 정렬·공백 정규화한 JSON 내용 해시. 서명 또는 `plan_hash`가 아님 |
| `provenance` | `caller_asserted`, `image_verified=false`: 제공받은 값이며 이미지와 소스의 관계를 검증하지 않았음 |

도구는 값의 형식과 결과 내부 일관성만 검사합니다. 로컬 ID와 레지스트리 digest는 문자열 모양이
같을 수 있어 정규식 검사만으로 구분할 수 없습니다. 공통 식별자로 파이프라인 run_id·앱 Git SHA·레지스트리
digest를 쓰기로 한 것은 합의됐습니다. 레지스트리 위치와 실제 값의 전달·빌드 연결은 아직 남아 있습니다.
승인이나 서명을 대신하지 않습니다. `verify` 결과는 이 배포 전 인계 명령에 넣을 수 없습니다.

인계 명령 종료 코드 0은 **파일 작성 성공**이고, 앱의 `passed=false`를 뒤집지 않습니다.
입력이 잘못되면 2로 끝나며 원본 파일은 수정하지 않습니다. 전체 조건이 끝나지 않은 오류도
검사 통과로 바뀌지 않습니다. 전체 조건의 분모를 합치면 동일 요청을 조건별로 반복한 횟수라는 점도
정책 쪽에서 함께 표시해야 합니다.

## 5. 합의된 방향과 남은 연결 확인

- 기본 CLI 경로: 주영님이 AI 수정 후 새 이미지로 컨테이너를 실행하고, 윤선님 `test`로 같은 기준 재검사. 담당은 확정됐으며 실제 전달·실행 확인이 남아 있음.
- 별도 어댑터 경로를 사용할 경우에만 `ParityReplayPort` loader 연결이 필요함.
- 류진님 변환기에 실제 result·env_report·evidence 연결. 실패 데모는 차단 경로부터 확인하고, 서명 경로는 실제 통과 샘플로 별도 확인.
- `none/restart/replace` 원본과 저장 방식 사실을 유지하고 대상·해결 조건은 Policy가 판단하는 방향은 합의됨. 조건 실패를 전체 실패와 환경 제약으로 재분류하는 세부 규칙은 미합의.
- 레지스트리 위치 결정, 주영님이 기록한 실제 digest·앱 SHA와 파이프라인 run_id 전달·결속 확인.
- 공통 원본을 JSON Schema로 삼는 방향은 확정. 최종 변환 입력을 공통 계약에 반영하고 두 파트의 실제 파일로 검증하는 작업은 별도 확인.
- `Policy.requires`를 AI 수정 목표로 읽고 재검증·Policy 재평가까지 자동화할 MVP 범위는 목요일 오후 논의 예정.
- 배포 후 `verify`를 위한 동일 초기 데이터와 쓰기 허용 범위. 실제 Cloud Run 검증은 아직 하지 않음.
- 비밀값을 가린 요청 본문·헤더에 실행 시 값을 주입하는 공통 매핑 규칙.
- 기존 비교기는 점·대괄호를 포함하는 JSON 키의 경로를 별도로 이스케이프하지 않습니다. 그런 키가 있는 임의 앱은 구조를 정확히 구별하지 못할 수 있어 현재 샘플 범위 밖의 한계입니다.

이전 어댑터 작업 당시 검증 기록은 `python -m unittest` **122개 통과**입니다. 현재 전체 개수로 사용하지 않습니다.
이후 회의 연결 작업에서는 윤선님이 전체 unittest의 최종 `OK`와 3조건 데모 두 회차를 확인했으며,
그 원본은 [MEETING.md](MEETING.md)에 기록했습니다. 이 이력은 조건 로그 표시·문서 정리 이전 결과이며,
표시 수정 후 검증까지 포함하지 않습니다. 표시 수정 확인 명령은 `python -m unittest tests.test_conditions tests.test_replace_condition -v`입니다.
HTTPS 검증은 자체 서명 인증서를 사용하는 로컬 프로세스 테스트이며,
위 Docker 연결 데모는 HTTP입니다.
