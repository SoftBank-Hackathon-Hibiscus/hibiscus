"""Docker 제어. 자기 라벨(premortem.owner=juyeong)과 run_id가 맞는 자원만 다룬다.

- 명령은 인자 배열로 실행하고(shell 없음) 시간 제한을 둔다.
- 컨테이너에는 명시한 검증 전용 환경변수만 넘긴다. 볼륨·Docker socket은 넘기지 않는다. 포트는 루프백(127.0.0.1)에만 게시한다.
- 권한은 최소로 둔다(--cap-drop ALL, no-new-privileges, 메모리·PID·CPU 상한). privileged·host network는 쓰지 않는다.
- 지울 때는 저장된 정확한 ID와 라벨을 확인한다. 이름만 보고 지우지 않고, 전역 정리 명령은 쓰지 않는다.
"""

import json
import re
from typing import Optional

from .config import CONDITION_LABEL_KEY, OWNER_LABEL_KEY, OWNER_LABEL_VALUE, RUN_LABEL_KEY, Settings
from .errors import PremortemError
from .process import CommandResult, CommandRunner

_IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
_TAG_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9_.-]{1,128}$")
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
_ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")


def _first_line(text: str) -> str:
    return (text.strip().splitlines() or ["출력 없음"])[0][:300]


class DockerDriver:
    def __init__(self, runner: CommandRunner, settings: Settings, environment=None):
        self.runner = runner
        self.settings = settings
        self.environment = dict(environment or {})
        if (len(self.environment) > 50
                or any(not isinstance(name, str) or not _ENV_NAME_RE.fullmatch(name)
                       or name in {'PORT', 'HIB_RUN_ID', 'HIB_DIGEST'}
                       or not isinstance(value, str) or len(value) > 4096
                       for name, value in self.environment.items())):
            raise PremortemError("INPUT_INVALID", "검증용 환경변수 형식이 잘못됨")

    def _run(self, args: list, timeout: Optional[float] = None, check: bool = True) -> CommandResult:
        result = self.runner.run(["docker", *args], timeout or self.settings.docker_command_timeout_sec)
        if check and result.returncode != 0:
            raise PremortemError("DOCKER_COMMAND_FAILED", f"docker {args[0]} 실패: {_first_line(result.stderr)}")
        return result

    def require_daemon(self) -> str:
        try:
            result = self._run(["version", "--format", "{{.Server.Version}}"], timeout=20, check=False)
        except PremortemError as error:
            raise PremortemError("DOCKER_UNAVAILABLE", error.message) from None
        if result.returncode != 0 or not result.stdout.strip():
            raise PremortemError("DOCKER_UNAVAILABLE", f"Docker daemon에 연결하지 못함: {_first_line(result.stderr)}")
        return result.stdout.strip()

    # 이미지 -------------------------------------------------------------
    def build(self, context: str, tag: str, labels: dict) -> str:
        if not _TAG_RE.fullmatch(tag):
            raise PremortemError("INPUT_INVALID", f"이미지 태그 형식이 아님: {tag}")
        args = ["build", "--quiet", "--tag", tag]
        for key, value in labels.items():
            args += ["--label", f"{key}={value}"]
        self._run([*args, str(context)], timeout=self.settings.build_timeout_sec)
        return self.image_id(tag)

    def image_id(self, reference: str) -> str:
        image_id = self._run(["image", "inspect", "--format", "{{.Id}}", reference]).stdout.strip()
        if not _IMAGE_ID_RE.fullmatch(image_id):
            raise PremortemError("IMAGE_IDENTITY_MISMATCH", f"로컬 이미지 ID 형식이 아님: {image_id[:80]}")
        return image_id

    def image_platform(self, image_id: str) -> str:
        return self._run(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image_id]).stdout.strip()

    # 컨테이너 -----------------------------------------------------------
    def create(self, image_id: str, run_id: str, condition: str, container_port: int, sequence: int,
               host_port: Optional[int] = None) -> str:
        if not _IMAGE_ID_RE.fullmatch(image_id):
            raise PremortemError("IMAGE_IDENTITY_MISMATCH", "컨테이너는 고정한 로컬 이미지 ID로만 만든다")
        name = f"premortem-{run_id}-{condition}-{sequence}"
        if not _NAME_RE.fullmatch(name):
            raise PremortemError("INPUT_INVALID", f"컨테이너 이름 형식이 아님: {name}")
        if host_port is not None and (type(host_port) is not int or not 1 <= host_port <= 65535):
            raise PremortemError('INPUT_INVALID', '호스트 포트는 1~65535 정수여야 함')
        args = [
            "create", "--name", name,
            "--label", f"{OWNER_LABEL_KEY}={OWNER_LABEL_VALUE}",
            "--label", f"{RUN_LABEL_KEY}={run_id}",
            "--label", f"{CONDITION_LABEL_KEY}={condition}",
            "--publish", f"127.0.0.1:{host_port or ''}:{int(container_port)}",
            "--memory", "256m", "--pids-limit", "128", "--cpus", "1",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        ]
        for key in sorted(self.environment):
            args += ["--env", f"{key}={self.environment[key]}"]
        args.append(image_id)
        container_id = self._run(args).stdout.strip()
        if not _CONTAINER_ID_RE.fullmatch(container_id):
            raise PremortemError("DOCKER_COMMAND_FAILED", "컨테이너 ID를 받지 못함")
        return container_id

    def start(self, container_id: str) -> None:
        self._run(["start", container_id])

    def inspect(self, container_id: str) -> dict:
        """필요한 필드만 골라 돌려준다. Env 값은 비밀값이 있을 수 있어 가져오지 않는다."""
        raw = json.loads(self._run(["container", "inspect", container_id]).stdout)[0]
        state, config, host = raw.get("State") or {}, raw.get("Config") or {}, raw.get("HostConfig") or {}
        return {
            "id": raw.get("Id"),
            "image": raw.get("Image"),
            "started_at": state.get("StartedAt"),
            "running": bool(state.get("Running")),
            "exit_code": state.get("ExitCode"),
            "labels": config.get("Labels") or {},
            "env_names": sorted(item.split("=", 1)[0] for item in (config.get("Env") or [])),
            "mounts": [m.get("Destination") for m in (raw.get("Mounts") or [])],
            "privileged": bool(host.get("Privileged")),
            "network_mode": host.get("NetworkMode"),
            "cap_drop": host.get("CapDrop") or [],
        }

    def verify_owned(self, container_id: str, run_id: str) -> dict:
        info = self.inspect(container_id)
        labels = info["labels"]
        if labels.get(OWNER_LABEL_KEY) != OWNER_LABEL_VALUE or labels.get(RUN_LABEL_KEY) != run_id:
            raise PremortemError("OWNERSHIP_MISMATCH", f"이 실행이 만든 컨테이너가 아니어서 건드리지 않음: {container_id[:12]}")
        return info

    def restart(self, container_id: str, run_id: str) -> None:
        self.verify_owned(container_id, run_id)
        self._run(["restart", "--time", "2", container_id])

    def remove(self, container_id: str, run_id: str) -> None:
        self.verify_owned(container_id, run_id)
        self._run(["rm", "--force", container_id])

    def host_port(self, container_id: str, container_port: int) -> int:
        output = self._run(["container", "port", container_id, f"{int(container_port)}/tcp"]).stdout
        for line in output.splitlines():
            host, _, port = line.strip().rpartition(":")
            if host == "127.0.0.1" and port.isdigit():
                return int(port)
        raise PremortemError("DOCKER_COMMAND_FAILED", "루프백에 게시된 포트를 찾지 못함")

    def diff(self, container_id: str) -> list:
        return [line for line in self._run(["container", "diff", container_id]).stdout.splitlines() if line.strip()]

    def logs(self, container_id: str, tail: int = 200) -> str:
        result = self._run(["logs", "--tail", str(int(tail)), container_id], check=False)
        return (result.stdout + result.stderr)[-65536:]

    def exec_probe(self, container_id: str, command: list, timeout: float = 10) -> CommandResult:
        return self._run(["exec", container_id, *command], timeout=timeout, check=False)

    def cleanup(self, container_ids: list, run_id: str) -> list:
        """자기 컨테이너만 지운다. 지우지 못한 ID 목록을 돌려준다(CLEANUP_FAILED 안내용)."""
        failures = []
        label_format = ('{{index .Config.Labels "%s"}}|{{index .Config.Labels "%s"}}'
                        % (OWNER_LABEL_KEY, RUN_LABEL_KEY))
        for container_id in dict.fromkeys(container_ids):
            try:
                found = self._run(["container", "inspect", "--format", label_format, container_id], check=False)
                if found.returncode != 0:
                    continue  # 이미 지워짐
                owner, _, owner_run = found.stdout.strip().partition("|")
                if owner != OWNER_LABEL_VALUE or owner_run != run_id:
                    failures.append(container_id)
                    continue
                if self._run(["rm", "--force", container_id], check=False).returncode != 0:
                    failures.append(container_id)
            except PremortemError:
                failures.append(container_id)
        return failures
