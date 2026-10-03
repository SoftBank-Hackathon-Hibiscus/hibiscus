# 실제 parity 연결안

PR #21의 빌드 명령과 #24의 `backend-test`를 TestStage에서 호출하는 검토용 변경입니다.
Backend #20·#26 구조를 기준으로 작성했습니다. 기존 fixture 실행은 유지하며, 아래 설정을
명시한 환경에서만 실제 Docker 빌드·업로드·시험을 실행합니다.

## 연결 범위

1. Backend가 만든 deployment ID와 요청한 전체 소스 SHA를 사용합니다.
2. digest가 placeholder이면 앱 커밋을 빌드·업로드합니다. Git HEAD가 요청 SHA와 다르면 빌드 전에 멈춥니다.
3. 빌드 기록의 run ID·소스 SHA·저장소를 대조한 뒤 실제 이미지로 세 조건을 시험합니다.
4. 완료한 시험의 불일치는 `test_passed=false`로 정책에 넘깁니다. 시험 중단은 단계 실패입니다.
5. 원본 결과를 저장할 때 실제 digest로 검사하고, 저장까지 성공한 뒤 DB의 digest와 소스 검증 상태를 갱신합니다.
6. 정책은 시험에 사용한 소스 복사본을 읽습니다.

`sourceRevisionVerified`는 실제 시험 이미지와 요청 소스 SHA의 연결을 뜻합니다.
수동 요청·인증된 GitHub 웹훅·fixture 시험만으로는 `true`가 되지 않습니다.
실제 registry parity가 완료되고 산출물의 식별값 검증과 DB 저장이 성공해야 갱신합니다.
완료된 불일치도 소스 연결은 검증될 수 있으므로, 앱의 `passed`와 정책의 `decision`을
별도로 확인합니다. 실서명·실배포는 검증되지 않은 소스를 외부 명령 실행 전에 거부합니다.
정책 분류는 `--classifier heuristic`으로 명시합니다.

현재 검토 작업본에서는 팀 GCP 레지스트리 업로드·pull·amd64 재시험을 확인했습니다.
팀 Backend 환경의 인증·입력 경로·빌드 도구는 별도로 준비해야 합니다. 이 변경을 승인받기 전에는
공용 Backend에 적용하지 않습니다. 앱 등록 API와 DB 스키마는 바꾸지 않았습니다.

## 실행 환경 설정

Node 24에서 `npm ci`, `npm run build`, `npm run lint`를 확인합니다. Node 22.17/npm 10에서는
현재 lockfile의 peer 의존성 때문에 `npm ci`가 실패했고, Node 24.15 환경에서는 설치됐습니다.
`parity/requirements.txt`와 `policy/`의 Node 의존성도 설치해야 합니다.

```sh
STAGE_MODE=cli
PARITY_TEST_MODE=registry
PARITY_INPUTS_FILE=/workspace/parity-inputs.json
PARITY_PYTHON_COMMAND=/workspace/venv/bin/python
PARITY_BUILDER=hib-builder
PARITY_PLATFORMS=linux/amd64,linux/arm64
PARITY_TIMEOUT_MS=1200000
SIGNER_MODE=dry
DEPLOY_MODE=off
```

`PARITY_INPUTS_FILE`은 운영자가 관리하는 파일이며 앱 slug로 기록을 찾습니다.
기록 파일 경로를 앱 DB에 저장할지는 태현님과 연결할 때 정할 부분입니다.

```json
{
  "guestbook": {
    "record": "/workspace/records/guestbook/session.jsonl",
    "noise": "/workspace/records/guestbook/noise.json",
    "after": [10],
    "health_path": "/healthz",
    "health_timeout": 30
  }
}
```

미리 빌드한 digest를 입력하는 경우에는 앱 항목에 `build_manifest_directory`를 추가합니다.
`<directory>/<deployment.id>/build_manifest.json`과 그 옆 `source/`를 준비해야 하며,
기록의 run ID·SHA·digest가 현재 deployment와 같아야 합니다. 다른 실행의 빌드를 재사용하지 않습니다.

## 검증

```sh
npm run build
npm run lint
npm test
npm run test:e2e
```

일반 E2E 실행에서는 실제 Docker 시험을 건너뜁니다. 실제 시험은
`parity/scripts/rehearse_pipeline.py --backend`가 로컬 레지스트리를 준비한 뒤 호출합니다.
방명록의 의도된 실패가 policy block으로 이어지고, 결과와 실제 digest가 DB에 보존되는지 봅니다.
다른 소스 SHA가 들어오면 빌드 전 실패하는 경우도 확인합니다. 서명·배포와 실제 LLM은 호출하지 않습니다.

실제 테스트 연결 후에도 앱 등록·webhook·서명 키·배포 환경 구성은 각 담당자의 검토와 전체 연결 검증이 필요합니다.

## 실행 실패 진단

registry parity의 checkout·build·test 명령이 실패하거나 시간 초과되면 해당 stage의 `summary`에
`command_phase`, `exit_code`, `signal`, `timed_out`, `stdout_tail`, `stderr_tail`을 저장합니다.
CLI의 `--json` 오류는 stdout에 나올 수 있으므로 두 출력을 함께 확인합니다. 각 tail은 마지막
20줄·4,000자 이내이며 알려진 토큰·비밀번호·개인키 패턴을 가린 뒤 자릅니다. 모든 민감정보를
자동 판별하는 기능은 아니므로 앱 로그에 비밀값을 출력하지 않아야 합니다.

외부 명령 출력은 스트림당 마지막 1Mi 문자까지 보관하고 넘치면 `output_truncated=true`로
표시합니다. Linux에서는 시간 초과 시 명령의 프로세스 그룹을 종료하고, 1초 후에도 남은
자식 프로세스는 강제 종료합니다. Docker daemon이 따로 관리하는 컨테이너·빌드 작업의 정리까지
뜻하지는 않습니다. 실패한 실행은 소스 검증 완료나 실서명·실배포로 진행하지 않습니다.
