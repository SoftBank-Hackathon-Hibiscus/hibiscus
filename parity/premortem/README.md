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

`parity/`에서 실행합니다. Docker가 필요한 건 demo와 `--docker` 시험뿐입니다.
AI 수정 기능은 jsonschema가 있어야 AI 출력을 받아들입니다: `pip install -r requirements.txt`

```sh
python -m premortem doctor
python -m premortem demo --scenario state-loss
python -m premortem demo --scenario binding --ai fixture
python -m premortem self-test            # Docker 없이
python -m premortem self-test --docker   # 실제 Docker 시험까지
```

실행 결과는 `premortem/.runs/`에 쌓이고 커밋되지 않습니다. 테스트 컨테이너는 `premortem.owner=juyeong` 라벨이 붙은 것만 만들고 지웁니다.
