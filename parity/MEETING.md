# 9/30 회의 합의에 맞춘 테스트 연결

## 연결 방식

```text
주영: Dockerfile로 이미지 빌드 + 최초 컨테이너 실행
  → 윤선: python -m parity test
      → 조건별 docker_ops.recreate로 초기화
      → 같은 사용 기록을 재생·비교
      → restart / replace 훅은 요청 사이에 실행
      → result.json + result.diagnostics.json
  → 정책 측 변환기 → Policy → 승인·서명
```

`replace`는 주영님 PR #8에 병합된 구현을 사용합니다. `premortem ConditionRunner`를 호출하는
별도 어댑터 데모와 구분합니다. 이름·고정 포트가 유지되므로 기본 경로에는 동적 주소 변경이 필요 없습니다.
바인딩 등 환경 원인 분석은 주영님 영역이며, 이 모듈은 실패 단계와 검사 결과를 전달합니다.
빌드·최초 실행, AI 수정 후 새 이미지 빌드·실행, digest 기록은 주영님이 맡습니다.
조건별 재생성은 윤선님의 `docker_ops.recreate`를 사용하고, `run_id`는 파이프라인에서 받습니다.
`test`의 기본 조건은 `none,restart,replace`이며, 주영님 파이프라인 호출에도 세 조건을 명시하기로 했습니다.
로컬 개별 검사에서는 조건을 골라 실행할 수 있지만 Policy 제출에는 세 조건 모두 필요합니다.
기존 `demo.sh`·`demo.ps1`은 두 조건을 명시하는 개별 데모로 유지하며 Policy 제출용으로 쓰지 않습니다.

## 최초 실행을 맡은 쪽에서 전달할 정보

| 값 | 의미 |
|---|---|
| container | 테스트 전용 컨테이너 이름 |
| target | 그 컨테이너의 고정 게시 포트로 접속하는 http/https 주소 |
| expected image ID | 해당 컨테이너가 사용해야 하는 로컬 이미지 ID. 선택 인자로 제공 |
| record / noise | 함께 고정해 사용할 기록 JSONL과 노이즈 규칙 |

동일한 초기 데이터가 전제입니다. 현재 방명록은 외부 볼륨 없이 빈 상태에서 시작합니다.
명시적 볼륨을 쓰면 그 데이터는 재생성해도 남으므로, 별도로 초기 데이터를 준비해야 합니다.

```text
python -m parity test --record records/session.jsonl --target http://127.0.0.1:8080 --container guestbook --conditions none,restart,replace --restart-after 10 --out records/run/result.json
```

새로 빌드한 이미지인지 확인하려면 `--expected-image-id sha256:<로컬 이미지 ID>`를 추가합니다.
지정한 컨테이너의 이미지가 다르면 재생성하기 전에 실패합니다. 조건 시작·초기화 직후·재생 종료에도
처음 고정한 컨테이너 이미지 ID를 확인합니다.

**주의:** target 주소와 컨테이너의 실제 연결까지 증명하는 기능은 아닙니다.
전달자가 올바른 게시 포트의 주소를 제공해야 하며 진단에는 `target_binding_verified=false`로 표시합니다.
로컬 ID를 registry digest나 소스 SHA의 증명으로 사용하지 않습니다.

AI 수정 뒤에도 **동일한 기록·노이즈 파일**을 사용합니다. 이미지 태그만 새로 붙여도 기존 컨테이너는
이전 이미지를 사용합니다. **주영님이 새 이미지로 컨테이너를 실행한 뒤 윤선님의 `test`로 재검사**하는
방식은 합의됐습니다. 새 컨테이너·주소·이미지 ID의 실제 전달과 AI 수정 후 연결 실행은 아직 확인 전입니다.
`--expected-image-id`로 전달받은 버전과 다른 컨테이너를 검사하는 것을 막을 수 있습니다.

## 재생성에서 지키는 범위

- 기존 컨테이너의 실제 이미지 ID와 이름, 고정 TCP 포트를 유지합니다.
- 자동 포트(`0`/빈 값), 미게시 포트, 지원하지 않는 네트워크·마운트 구성은 삭제 전에 거부합니다.
- 라벨, 기본 보안 옵션, CPU·메모리·PID 제한, 사용자·작업 폴더·실행 명령을 지원 범위 안에서 유지합니다.
- `--mount`, 익명 볼륨, 사용자 네트워크, 추가 장치·권한, 자동 재시작 등 지원하지 않는 설정은 자동 복제하지 않습니다.
- 기본 CLI는 마지막 컨테이너를 남깁니다. 전체 파이프라인의 최종 정리 담당은 아직 미정입니다.
- 회의 데모 스크립트는 자체 생성한 고유 이름·실행 라벨의 컨테이너만 정리합니다.

## 판정과 실행 오류를 구분하기

| 종료 코드 | 뜻 | 다음 단계 |
|---|---|---|
| 0 | 요청한 모든 조건에서 전부 일치 | 결과·실행 식별정보를 정책에 전달 |
| 1 | 요청을 실행했지만 응답 불일치 있음 | 원본 근거를 정책/수정 단계에 전달. 승인·배포 성공으로 취급하지 않음 |
| 2 | 입력·컨테이너 준비·연결·사실 수집·기준 파일 등 실행 오류 | 테스트 미완료로 차단하고 진단 확인 |

`test`는 시작 시 이번 실행의 실패/진행 상태를 먼저 기록합니다. 준비 확인 실패 등 실행 오류에도
`passed=false`와 `replay[].error`를 남깁니다. 보내지 못한 요청을 HTTP 불일치로 꾸미지 않습니다.
현재 조건의 부분 응답은 보존하고 이후 조건은 `NOT_EXECUTED`로 남깁니다.
0개 요청, 중복 조건, 본문 전체를 제외하는 노이즈 규칙, 장애를 한 번도 주입할 수 없는 조건은 거부합니다.
`--restart-after`에 마지막 요청이나 범위 밖 번호를 지정해 일반 재생만 통과시키는 것도 거부합니다.

출력 경로가 입력 파일과 같거나 링크로 같은 파일을 가리키면 입력 보호를 위해 실행하지 않습니다.
명령 인자 자체가 잘못되어 파서에서 거부되거나 파일을 쓸 수 없는 경우는 결과 저장이 불가능할 수 있습니다.
**소비자는 파일 존재만으로 성공을 판단하지 말고, 프로세스 종료 코드와 이번 실행의 진단 상태를 함께 확인해야 합니다.**
실행마다 별도 출력 폴더를 사용하세요. 두 출력 파일 전체를 하나로 저장하는 트랜잭션은 아닙니다.

## 출력과 정책 연결

기존 `result.json` 최상위 형식은 유지합니다.

```text
stage / commit / image / passed / facts / replay / mismatches
```

`facts`는 `{kind, path, storage, evidence}` 목록 그대로입니다. `facts.db`, `facts.writes_local_file` 등으로의
정규화는 류진님 쪽에서 처리합니다. `related_fact`는 원인을 확정하는 값이 아니라 관련 관측 경로의 힌트입니다.
`commit`은 도구 작업 트리 기준의 기존 필드이며 앱 소스 SHA가 아닙니다.
류진님이 Policy 앞 변환기에서 윤선님의 `result.json`과 주영님의 `env_report`를 공통 입력으로 연결합니다.
원본 result·env_report·facts·evidence는 보존합니다. 주영님의 `env_report`·`evidence`·`handoff_bundle`을
보존하는 방향도 합의됐지만, 현재 이 문서에서 대조한 실제 `env_report` 예시는 아직 없습니다.

### 류진님 PR #12에서 전달받은 구현·검증 보고

출처: [PR #12](https://github.com/SoftBank-Hackathon-Hibiscus/hibiscus/pull/12)에 관한 류진님 공유 내용.
아래는 **팀원이 보고한 상태**이며, 이 문서 갱신 중 PR 소스를 직접 검토하거나 검증 명령을 실행하지 않았습니다.

- 정규화는 구현됐고 원본 `passed`·facts를 보존합니다. 조건 결과가 없는 legacy 입력에만 기존 `passed` fallback을 적용합니다.
- `none` 불일치는 `block / fix_tests`, `restart` 불일치는 `block / fix_restart_failure`로 처리합니다.
- `replace`만 실패하면 SQLite·로컬 파일 사실로 설명 가능한 경우 기존 R5/R6로 처리하고, 설명되지 않으면 `block / investigate_replace_failure`로 처리합니다.
- 알 수 없는 조건, 전체 요청 0개, 수치·failed·불일치 개수의 불일치, 중단된 검사는 허용하지 않습니다. `--handoff`와 `--test` 입력에 같은 불변 조건을 적용합니다.
- 레지스트리 digest가 있으면 metadata와 일치를 검사합니다. 로컬 이미지 ID와 `metadata.digest`가 같으면 경고합니다.
- `npm` 테스트 266개, 타입 검사·contracts 검사를 통과했고 두 입력 경로의 결과가 같았다는 보고를 받았습니다.
- PR #10 `b0a2c50`의 `meeting_result.json` 사본은 `block`과 `fix_restart_failure`, `managed_db`, `object_storage`로 처리됐다고 합니다.

따라서 변환기와 조건별 판정 규칙을 여전히 미구현·미정이라고 보지 않습니다. 주영님 실제 `env_report`는
제공 예정이며 아직 받지 않았고, 실제 빌드 metadata를 포함한 전체 파이프라인 연결은 별도 확인이 필요합니다.

자동 생성하는 `result.diagnostics.json`은 로컬 연결용 보조 파일입니다. 공통 계약으로 확정한 스키마가 아닙니다.

| 필드 | 뜻 |
|---|---|
| status / phase | running, completed, error 및 input/identity/prepare/replay/facts 등 현재 단계 |
| local_image_id | 검사 중 고정한 실제 컨테이너 이미지 ID |
| registry_digest / source_revision | 이 모듈에서 검증하지 않으므로 null |
| baseline_sha256 | 최초에 읽은 기록·노이즈 파일의 SHA-256. 노이즈 파일이 없으면 null |
| baseline_unchanged | 실행 중 기준 파일을 바꾸지 않았는지 |
| facts_collected | false이면 facts=[]가 관찰 완료 또는 위험 없음이라는 뜻이 아님 |
| conditions | 조건별로 전송을 시도한 요청 수 |
| error | 실행이 중단된 조건·단계·오류 종류. 환경 분석기가 참고할 수 있음 |

처음 관찰한 조건의 facts를 유지합니다. 조건별 일치 수와 불일치, 실행 진단은 각각 보존합니다.
조건별 분모를 합한 값은 같은 요청을 반복한 횟수이며 서로 다른 사용자 행동 수가 아닙니다.

공통 식별자는 파이프라인의 `run_id`, 앱 Git SHA인 `source_revision`, registry `digest`를 사용하기로 했습니다.
주영님이 빌드 결과의 digest를 기록합니다. **레지스트리 위치와 이 값들을 실제 파일로 전달하는 연결은 미완료**입니다.
별도 `python -m parity.handoff`는 원본과 제공받은 정보를 묶는 **제안 형식**이며,
정책 CLI에 바로 넣는 최종 공통 입력도, 이미지 출처 증명도 아닙니다.
공통 JSON Schema를 원본으로 사용하기로 한 합의와, 이 제안 파일이 공통 계약으로 채택됐다는 것은 다릅니다.

## 사용자가 실행할 검증

`parity/` 폴더에서 다음 두 명령을 실행합니다.

```text
python -m unittest
python scripts/demo_meeting.py
```

회의 데모는 기존 `guestbook`을 건드리지 않고 자체 컨테이너를 만들며, 다음 흐름을 실행하도록 작성했습니다.

1. 샘플 앱 이미지 한 번 빌드 → 사용 기록 20개 수집.
2. 초기 상태에서 두 번 재생해 노이즈 규칙 생성.
3. CLI에 none/restart/replace를 명시해 실행. 10번 요청 뒤 조건 적용.
4. 동일한 이미지와 동일한 기준 파일로 한 번 더 실행해 결과의 재현성 확인.
5. 원본 결과·해시·진단·실행 로그를 보존하고 자체 컨테이너 정리.

방명록에 의도적으로 넣은 결함의 **기대값**은 none 20/20, restart 14/20, replace 13/20입니다.
replace에서 16번 업로드 목록 조회가 추가로 달라져야 합니다.
앱의 `passed=false`와 데모의 `demo_expectations_met=true`는 뜻이 다릅니다.
반복 시험은 실제 AI 패치나 정책·서명·Cloud Run 통합 시험이 아닙니다.

### 실제 실행 확인

윤선이 터미널에서 전체 `python -m unittest`를 실행하고 최종 `OK`를 확인했습니다.
최신 테스트 개수는 별도로 전달되지 않아 적지 않습니다. 이전의 124개를 이번 실행 개수로 쓰지 않습니다.
이 표는 조건별 로그 표시·문서 정리와 기본 조건 3개 적용 이전의 실행 결과입니다.
이후 변경에 대한 재실행 결과로 해석하지 않습니다. 기본 조건과 조건 표시 확인 명령은 다음과 같습니다.

```text
python -m unittest tests.test_execution tests.test_conditions tests.test_replace_condition -v
```

`scripts/demo_meeting.py` 실행 ID: `meeting-20260930-173237-f746f560b3`.
아래 수치는 터미널 출력과 저장된 원본 결과·진단·데모 보고서를 대조한 값입니다.

| 조건 | 1회차 | 2회차 | 불일치 요청 번호 |
|---|---|---|---|
| none | 20/20 | 20/20 | 없음 |
| restart | 14/20 | 14/20 | 11, 12, 13, 14, 17, 20 |
| replace | 13/20 | 13/20 | 11, 12, 13, 14, 16, 17, 20 |

- 각 조건에서 실제 요청 20개를 실행했고 두 진단 모두 `status=completed`, `error=null`입니다.
- 기록·노이즈 파일과 로컬 이미지 ID가 두 실행 동안 유지됐습니다.
- `replace`에서 추가된 16번 실패는 `GET /uploads` 결과에서 `cat.png`가 사라진 것입니다.
- 한 회차의 불일치 13건은 restart 6건 + replace 7건입니다. 서로 다른 결함 13종이라는 뜻은 아닙니다.
- 앱 판정은 `passed=false`, 데모 기대값 확인은 `demo_expectations_met=true`, 반복 결과는
  `repeatable=true`입니다. 자체 데모 컨테이너 정리도 완료됐고 빌드 이미지는 남아 있습니다.

정책 파트에 전달할 1회차 원본 결과의 공유 사본:

- [실제 검사 결과](examples/meeting_result.json)
- [실제 실행 진단](examples/meeting_result.diagnostics.json)

JSON 값은 원본 그대로 보존했습니다. 두 파일은 결함을 넣은 방명록의 실행 예시이며,
팀 공통 스키마나 정책 변환 완료를 뜻하지 않습니다. `image`와 `local_image_id`는 Docker 로컬
이미지 ID입니다. `registry_digest`, `source_revision`은 여전히 null이고 주소·컨테이너 연관성은
자동 검증하지 않았습니다.

전체 원본·2회차 결과·실행 로그는 로컬의
`records/meeting/meeting-20260930-173237-f746f560b3/`에 남아 있습니다.
`records/`는 Git 제외 대상이며, 공유 사본만 `examples/`에 포함합니다.
실제 AI 수정, 정책·승인·서명, Cloud Run 연결 시험은 이번 실행에 포함되지 않았습니다.

## 테스트 → 정책: 회의 안건 8개 현황

아래는 회의 안건 순서대로 합의와 실행 상태를 구분한 표입니다. 합의된 역할을 다시 미정으로 표시하지 않습니다.

| # | 안건 | 합의·현재 구현 | 남은 확인 |
|---|---|---|---|
| 1 | `result.json` + `env_report` → Policy 입력 | 류진님 변환기 구현 및 두 입력 경로 검증 보고를 받음(PR #12). 윤선 원본 결과·진단은 `examples/meeting_result*`에 있음 | 주영님 실제 `env_report`를 받아 함께 실행. 아직 수신 전이며 파이프라인 E2E도 미검증 |
| 2 | 원본 `facts/evidence` 보존 위치 | 원본 result·env_report·evidence 보존에 합의. 윤선 전체 원본은 위 `records/meeting/<run_id>/`, 공유 사본은 `examples/`. 주영님은 `env_report`·`evidence`·`handoff_bundle` 보존 | 파이프라인에서 두 파트의 산출물을 전달·보관하는 최종 경로 연결 |
| 3 | `facts.db`, `facts.writes_local_file` 정규화 | 류진님이 구현·검증 보고(PR #12). 윤선 `{kind, path, storage, evidence}` 원본 형식 유지 | 실제 env_report와 빌드 metadata를 더한 연결 결과 대조 |
| 4 | `none/restart/replace` 결과 형식 | 윤선 `replay[]`·`mismatches[]` 원본 유지. 기본값과 파이프라인 호출은 세 조건, Policy 제출에도 세 조건 필수 | 실제 파이프라인에서 세 조건 결과가 모두 전달되는지 확인 |
| 5 | 전체 실패와 환경 제약 사실 구분 | 원본 `passed` 보존. PR #12 보고상 none/restart 실패는 각각 fix_tests/fix_restart_failure로 차단하고, replace-only 실패는 관측 사실로 설명 가능한지 구분 | 직접 소스 검토·실제 파이프라인 실행은 미확인. 규칙 구현 자체가 미정인 것은 아님 |
| 6 | replace 유실과 저장 사실로 Policy 판단 | PR #12 보고상 설명 가능한 replace-only 실패는 R5/R6, 나머지는 investigate_replace_failure로 차단. 현재 샘플은 restart도 실패해 block 및 fix_restart_failure·managed_db·object_storage | 실제 env_report와 함께 target·requires 결과 확인 |
| 7 | `run_id/source_revision/digest` 전달 | 파이프라인 run_id·앱 Git SHA·레지스트리 digest 사용에 합의. 주영님이 빌드·digest 기록. 외부 값을 원본과 묶는 `parity.handoff`는 구현된 제안 도구 | 레지스트리 위치 미정. 실제 값 전달·이미지와의 연결 미검증. 기존 result 키에 임의 필드를 추가하지 않음 |
| 8 | `Policy.requires`를 AI 수정 목표로 사용 | MVP 자동화 범위는 목요일 오후 논의 예정 | AI 수정 → 같은 기준 재검증 → Policy 재평가를 어디까지 자동화할지 결정 |

## 합의 후 함께 실행할 것

- 주영·윤선: 준비 실패 시 바인딩 진단 호출과, AI 수정 후 새 이미지·컨테이너 전달 → 같은 기록 재검사.
- 류진·주영·윤선: 실제 result + 진단 + env_report를 변환기로 연결하고 원본 근거가 유지되는지 확인.
- 빌드·배포: 레지스트리 위치 결정 후 run_id·앱 SHA·실제 digest 전달과 동일 이미지 사용 확인.
- 공통: 최종 컨테이너 정리 담당 확정, 실제 통과 앱으로 승인·서명까지 첫 E2E, 배포 후 `verify` 실행.

담당과 방향이 합의된 것, 코드가 있는 것, 실제로 함께 실행한 것은 각각 구분합니다.
현재 3조건 데모 성공만으로 전체 팀 파이프라인이 완료됐다고 표시하지 않습니다.
