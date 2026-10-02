"""윤선님 parity 재생기 연결.

재생·비교·노이즈 규칙은 윤선님 parity.premortem_adapter.ParityReplayPort가 맡고,
이 모듈은 컨테이너 조건과 증거만 맡는다. parity/ 폴더에서 실행해야 parity 패키지를 찾는다.
"""

from ..errors import PremortemError


def load_parity_adapter(**options):
    try:
        from parity.premortem_adapter import ParityReplayPort
    except ImportError:
        raise PremortemError(
            "PARITY_ADAPTER_MISSING",
            "윤선님 parity 재생기(parity.premortem_adapter)를 찾지 못함. parity/ 폴더에서 실행하세요.",
        ) from None
    return ParityReplayPort(**options)
