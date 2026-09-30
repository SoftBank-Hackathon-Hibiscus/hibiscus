# 팀 연결 인계

9/30 밤 기준으로 윤선님 재생기는 `parity/record-replay` 브랜치에 올라와 있고, 류진님 정책은 main에 있습니다. 아직 서로 연결은 안 했습니다(dependency_missing). 지금 결과는 전부 개발용 샘플과 reference 재생기로 낸 것이라, 인계 묶음도 "팀 연동 대기(pending_team_integration)"로만 나옵니다.

코드를 받으면 아래 순서로 붙이고, 각 단계는 해당 담당자와 같이 돌려 보면서 확인합니다.

## 윤선님 재생기

확인할 것:

1. 코드 위치(팀 저장소 폴더)와 실행 방법
2. 재생 함수: 이름, 받는 것(session, noise, 대상 주소), 돌려주는 것(조건별 일치 수, 불일치 목록, facts)
3. 요청 사이 훅: i번 응답을 비교한 뒤, i+1번 요청 전에 불리는지. 훅이 끝난 뒤 대상 주소(포트)를 바꿀 수 있는지
4. 컨테이너를 누가 만들고 지우는지. 윤선님 `test` 명령은 조건마다 컨테이너를 지우고 다시 만든다고 적혀 있어서(윤선님 #3), 한 실행 안에서는 한 쪽만 하도록 정해야 합니다
5. 샘플 session.jsonl, noise.json, result.json 한 벌
6. 재생 중 쿠키와 가린 비밀번호를 어떻게 처리하는지
7. 방명록 기록에 업로드한 파일을 다시 받아오는 요청이 있는지. 없으면 replace로도 파일 유실을 보여 줄 수 없음

연결 방법(내 쪽):

- `premortem/adapters/parity_adapter.py`에서 윤선님 재생 함수를 `ReplayPort` 모양으로 감쌉니다. 윤선님 코드는 고치지 않습니다.
- 기본 제안은 윤선님 재생기가 요청을 보내고, 훅에서 이 모듈의 replace·바인딩 조건을 부르는 방식입니다. 훅 뒤에 주소를 바꿀 수 없으면, 이 모듈이 컨테이너를 만들고 윤선님 재생 함수만 부르는 방식으로 갑니다. 어느 쪽인지는 윤선님과 정하고 DECISIONS.md에 적습니다.
- 윤선님 facts 배열은 형식을 바꾸지 않고 그대로 넘깁니다. docker diff 같은 수집은 윤선님 쪽 결과를 쓰고 다시 만들지 않습니다.
- 연결되면 env_report의 replay_backend가 parity로 바뀌고, team_parity_integrated가 true가 됩니다.

윤선님 코드를 고쳐야만 붙는 경우엔 내 쪽 어댑터로 먼저 해결해 보고, 그래도 안 되면 필요한 최소 변경을 여기 적어서 윤선님께 부탁드립니다.

## 류진님 정책

확인할 것:

1. contracts 위치와 test_result 스키마 파일
2. result → test_result 변환기(류진님 작성 예정)의 실행 방법과 입력. 윤선님 result.json만 받는지, 이 모듈의 env_report도 받는지
3. match의 타입과 계산 방식
4. replace에서 실패한 결과를 passed에 합칠지, 정책이 읽는 사실로 따로 넘길지
5. 실제 plan.json 한 벌 (requires 모양 확인용)

내 쪽이 주는 것: `handoff_bundle.json`. env_report, run_manifest, evidence, 기준 기록, analysis·patch·review(있을 때)의 경로와 sha256이 들어 있습니다. 받는 쪽에서 hash가 안 맞으면 인계 실패로 봅니다.

plan.json의 requires를 AI 수정 목표로 읽는 부분은 만들어 뒀습니다(`--plan`). 류진님 개발일지의 형식을 흉내 낸 합성 plan으로만 시험했고, 실제 plan으로는 아직 안 돌려 봤습니다. allowed_targets는 "고치면 갈 수 있는 후보"로만 넘기고, 여러 개를 합쳐 배포 허가로 만들지 않습니다.

## 빌드, 배포 쪽

- 로컬 image ID와 레지스트리 digest는 다른 값입니다(같은 python:3.12-slim도 두 값이 달랐음). 레지스트리 digest를 어디서 받을지 정해야 합니다.
- 팀이 "한 번 빌드한 이미지로 테스트부터 배포까지"로 정하면, 이 모듈은 샘플 빌더로 직접 빌드하지 않고 받은 digest의 이미지를 검사하도록 바꿔야 합니다. 지금은 개발용 샘플만 직접 빌드합니다.

## 연결 리허설 순서

1. 윤선님 재생기로 방명록 none, restart를 다시 돌려서 윤선님이 전에 낸 결과와 같은지 본다
2. replace 훅을 붙여 방명록 replace를 돌린다
3. env_report와 result.json을 류진님 변환기에 넣고 contracts로 검사한다
4. plan.json의 requires를 AI 수정 목표로 읽는다
5. 수정 후 다시 검사한 새 이미지의 digest를 서명 쪽에 넘긴다
