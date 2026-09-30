# premortem 작업 지침

코딩 에이전트나 사람이 이 폴더를 고칠 때 지킬 것:

- 윤선님의 기록·재생·비교·노이즈·facts(`parity/parity`), 류진님의 정책·contracts는 여기서 다시 만들지 않는다. `adapters/reference_replay.py`는 `examples/premortem`의 샘플 전용이다.
- 명령은 `process.py`의 실행기로만 실행한다(허용 실행 파일, shell=False, timeout).
- Docker 자원은 `premortem.owner=juyeong` 라벨과 run_id가 맞는 자기 자원만 지운다.
- 0건, 누락, skip, 미연동은 통과가 아니다. fixture, reference, real, live, recorded를 섞어 표시하지 않는다.
- AI 출력은 검증을 통과한 edits만 복사본에 적용한다. 원본, Dockerfile, 기록, 정책, 테스트는 수정 대상이 아니다.
- API 키 같은 비밀값은 코드, 테스트, 기록 어디에도 넣지 않는다.
- 테스트는 `parity/`에서: `python -m unittest discover -s tests/premortem -t . -p "test_*.py" -v`
