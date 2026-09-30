"""Docker·재생기를 흉내 내는 테스트용 가짜 객체. 실제 Docker 없이 수명주기 규칙을 검사한다."""

from premortem.config import OWNER_LABEL_KEY, OWNER_LABEL_VALUE, RUN_LABEL_KEY
from premortem.process import CommandResult
from premortem.replay_port import ReplayHookError, ReplayOutcome, RequestResult

IMAGE_ID = "sha256:" + "ab" * 32
LOOPBACK_LISTEN = ("  sl  local_address rem_address   st\n"
                   "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n")


class FakeDocker:
    def __init__(self, running=True, internal_ok=True, proc_net=LOOPBACK_LISTEN, same_id_on_replace=False):
        self.containers = {}
        self.calls = []
        self.running = running
        self.internal_ok = internal_ok
        self.proc_net = proc_net
        self.same_id_on_replace = same_id_on_replace
        self._next = 0
        self._replace_id = None

    def create(self, image_id, run_id, condition, port, sequence):
        if self.same_id_on_replace and condition == "replace" and self._replace_id:
            container_id = self._replace_id  # 교체했는데 같은 ID가 돌아오는 잘못된 상황
        else:
            self._next += 1
            container_id = f"{self._next:064x}"
            if condition == "replace":
                self._replace_id = container_id
        self.containers[container_id] = {"image": image_id, "started": 0, "run_id": run_id}
        self.calls.append(("create", condition, container_id))
        return container_id

    def start(self, container_id):
        self.containers[container_id]["started"] += 1
        self.calls.append(("start", container_id))

    def inspect(self, container_id):
        c = self.containers[container_id]
        return {"id": container_id, "image": c["image"], "started_at": f"t{c['started']}", "running": self.running,
                "exit_code": 0 if self.running else 1,
                "labels": {OWNER_LABEL_KEY: OWNER_LABEL_VALUE, RUN_LABEL_KEY: c["run_id"]},
                "env_names": [], "mounts": [], "privileged": False, "network_mode": "bridge", "cap_drop": ["ALL"]}

    def host_port(self, container_id, port):
        return 40000 + int(container_id, 16)

    def restart(self, container_id, run_id):
        self.containers[container_id]["started"] += 1
        self.calls.append(("restart", container_id))

    def remove(self, container_id, run_id):
        self.containers.pop(container_id, None)
        self.calls.append(("remove", container_id))

    def diff(self, container_id):
        return ["C /app/data", "A /app/data/notes.db"]

    def logs(self, container_id, tail=200):
        return "listening on 127.0.0.1:8080\n"

    def exec_probe(self, container_id, command, timeout=10):
        self.calls.append(("exec", command[0]))
        if command[0] == "python":
            return CommandResult(tuple(command), 0 if self.internal_ok else 1, "200\n" if self.internal_ok else "", "")
        return CommandResult(tuple(command), 0, self.proc_net, "")

    def cleanup(self, container_ids, run_id):
        return []


class FakeReplay:
    """state-loss처럼 동작: 3번 뒤 replace되면 4·5번이 틀린다. 훅 호출을 기록한다."""

    backend = "reference"

    def __init__(self, docker, count=6, raise_on_replay=None):
        self.docker = docker
        self.count = count
        self.hook_calls = []
        self.raise_on_replay = raise_on_replay

    def replay(self, session_path, noise_path, target_for_request, after_response, runtime_secrets):
        if self.raise_on_replay:
            raise self.raise_on_replay
        outcome = ReplayOutcome("reference", self.count, 0, 0, [])
        replaced = False
        for index in range(1, self.count + 1):
            target_for_request(index)
            broken = replaced and index in (4, 5)
            outcome.results.append(RequestResult(index, not broken, "body" if broken else None, f"요청 {index}"))
            outcome.executed_count += 1
            outcome.matched_count += int(not broken)
            if index < self.count:
                before = len([c for c in self.docker.calls if c[0] == "create"])
                try:
                    after_response(index)
                except Exception as error:  # 실제 재생기와 같은 규칙: 삼키지 않고 지금까지 결과와 함께 올린다
                    raise ReplayHookError(error, outcome) from error
                self.hook_calls.append(index)
                replaced = replaced or len([c for c in self.docker.calls if c[0] == "create"]) > before
        return outcome


class FakeRunner:
    """docker 명령을 기록하고 정해 둔 응답을 돌려준다."""

    def __init__(self, responder):
        self.responder = responder
        self.calls = []

    def run(self, args, timeout):
        self.calls.append(list(args))
        return self.responder(list(args))
