"""외부 명령 실행. 허용한 실행 파일만, shell 없이, 시간 제한과 최소 환경변수로 실행한다.

테스트에서는 CommandRunner를 가짜로 바꿔 Docker 없이 검사한다.
"""

import os
import subprocess
from dataclasses import dataclass
from typing import Protocol, Sequence

from .errors import PremortemError

ALLOWED_EXECUTABLES = frozenset({"docker", "git"})

# 명령에 넘기는 환경변수. AI 키·클라우드 자격증명은 넘기지 않는다.
_ENV_PASSTHROUGH = (
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
    "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
    "SYSTEMROOT", "USERPROFILE", "TMP", "TEMP",
)


@dataclass(frozen=True)
class CommandResult:
    args: tuple
    returncode: int
    stdout: str
    stderr: str


class CommandRunner(Protocol):
    def run(self, args: Sequence[str], timeout: float) -> CommandResult: ...


def check_args(args: Sequence[str]) -> None:
    if not args or not all(isinstance(arg, str) for arg in args):
        raise PremortemError("COMMAND_DENIED", "명령 인자는 문자열 배열이어야 함")
    if args[0] not in ALLOWED_EXECUTABLES:
        raise PremortemError("COMMAND_DENIED", f"허용하지 않은 실행 파일: {args[0]}")
    if any("\x00" in arg for arg in args):
        raise PremortemError("COMMAND_DENIED", "인자에 NUL 문자가 있음")


class SubprocessRunner:
    def run(self, args: Sequence[str], timeout: float) -> CommandResult:
        check_args(args)
        env = {key: os.environ[key] for key in _ENV_PASSTHROUGH if key in os.environ}
        label = " ".join(args[:2])
        try:
            completed = subprocess.run(
                list(args), shell=False, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=timeout, env=env, stdin=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            raise PremortemError("TOOL_MISSING", f"실행 파일을 찾지 못함: {args[0]}") from None
        except subprocess.TimeoutExpired:
            raise PremortemError("TOOL_TIMEOUT", f"'{label}' 명령이 {timeout:g}초 안에 끝나지 않음") from None
        return CommandResult(tuple(args), completed.returncode, completed.stdout, completed.stderr)
