"""윤선님 guestbook-parity 재생기 연결 자리.

윤선님 재생기(parity/parity)는 아직 연결 전이다. 실제 저수준 재생 함수와 요청 사이 훅의 모양을 받은 뒤
ReplayPort 모양으로 감싼다. 존재하지 않는 함수나 CLI 옵션을 추측해서 호출하지 않는다.
연결에 필요한 정보는 docs/premortem/HANDOFF.md에 적어 둔다.
"""

from pathlib import Path

from ..errors import PremortemError


def load_parity_adapter(repo_root: Path):
    raise PremortemError(
        "PARITY_ADAPTER_MISSING",
        "윤선님 guestbook-parity 재생기를 이 저장소에서 찾지 못함. "
        "재생 함수·훅 모양을 받은 뒤 연결한다(docs/premortem/HANDOFF.md).",
    )
