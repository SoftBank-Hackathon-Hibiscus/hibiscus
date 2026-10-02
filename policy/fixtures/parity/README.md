# fixtures/parity — parity 실측 결과 사본

테스트 파트(윤선)가 방명록 샘플 앱(`sample-app/`)을 `python -m parity test` 로 실제 Docker 에서 검사한 결과의 사본이다.
변환기(`src/adapters/parity.ts`)와 R1 / R1b / R1c 규칙의 테스트 입력으로 쓴다.

| 파일 | 출처 |
|---|---|
| `meeting_result.json` | PR [SoftBank-Hackathon-Hibiscus/hibiscus#10](https://github.com/SoftBank-Hackathon-Hibiscus/hibiscus/pull/10) 의 `parity/examples/meeting_result.json` |
| `meeting_result.diagnostics.json` | 같은 PR 의 `parity/examples/meeting_result.diagnostics.json` |
| `meeting_handoff.json` | 위 result 를 `python -m parity.handoff` 로 묶은 것 (아래 명령) |

- 읽은 시점: 2026-10-01, PR #10 head commit `b0a2c50db6c4012adc7e731d2d7fd728d8f35676` (`fix(parity): align condition logs and handoff docs`)
- 두 파일은 바이트 그대로 복사했다. 값은 결함을 일부러 넣은 방명록의 실측이며 `none 20/20, restart 14/20, replace 13/20`, `passed=false` 다.
- `commit`은 parity 도구 저장소 기준이라 `"unknown"` 이고, `image` 와 `local_image_id` 는 로컬 image ID 다 (레지스트리 digest 가 아님).

## 인계 묶음을 만든 명령

레지스트리 위치와 실제 digest 전달이 아직 정해지지 않아 식별자는 자리표시자다.

```bash
# 팀 레포의 parity/ 에서
python -m parity.handoff --result ../policy/fixtures/parity/meeting_result.json \
  --run-id meeting-20260930-173237-f746f560b3 \
  --app guestbook \
  --source-revision b0a2c50db6c4012adc7e731d2d7fd728d8f35676 \
  --digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --out ../policy/fixtures/parity/meeting_handoff.json
```

| metadata | 값의 뜻 |
|---|---|
| `run_id` | 진단 파일의 컨테이너 이름(`parity-meeting-…`)에 들어 있는 실행 ID |
| `app` | 샘플 앱 이름 |
| `source_revision` | 자리표시자. PR #10 head commit 을 앱 소스 커밋 대신 넣었다 (실제로는 파이프라인이 앱의 커밋 SHA 를 준다) |
| `digest` | 자리표시자. 레지스트리가 정해지면 빌드 결과의 레지스트리 digest 로 바뀐다 |
