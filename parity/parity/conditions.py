"""3-A. 조건 재현.

"조건" = 재생하는 동안 일부러 일으키는 운영 이벤트. 2단계 재생기의 훅(ReplayHook)으로 구현한다.
  none    : 아무것도 하지 않는다. 기준선(baseline).
  restart : 지정한 요청이 끝난 직후 `docker restart <컨테이너>` 를 실행하고,
            /healthz 가 200 을 줄 때까지 최대 30초 기다린 뒤 다음 요청을 보낸다.
  replace : restart 와 같은 지점에서 컨테이너를 지우고 같은 설정으로 새로 만든다 (docker_ops.recreate).
            쓰기 계층이 초기 상태로 돌아가므로 컨테이너 안에만 저장한 파일이 사라지는지 본다.
            이름·포트가 그대로라 재생 대상 주소는 바뀌지 않는다.

조건 실행 지점 고르기 (요청 번호는 기록 파일의 index, 1부터. restart/replace 공통):
  --restart-after 3,7 : 3번, 7번 요청 뒤에 선택한 조건 실행
  --restart-every     : 모든 요청 사이 (1..N-1번 뒤)
  둘 다 없으면        : 가운데 한 번 (N/2번 뒤. N=20 이면 10번 뒤)
마지막 요청 뒤에는 조건의 영향을 볼 요청이 없으므로 실행하지 않는다.
"""
from . import docker_ops
from .replay import HookAbort, ReplayHook

SUPPORTED = ("none", "restart", "replace")


class NoneCondition(ReplayHook):
    name = "none"

    def describe(self):
        return "조건 없음"


class RestartCondition(ReplayHook):
    name = "restart"
    action = "재시작"
    operation = "docker restart"

    def __init__(self, container, health_url, after=None, every=False, health_timeout=30.0,
                 restart=docker_ops.restart, wait_healthy=docker_ops.wait_healthy, log=print):
        if after and every:
            raise ValueError("--restart-after 와 --restart-every 는 함께 쓸 수 없습니다")
        self.container = container
        self.health_url = health_url
        self.after = list(after or [])
        self.every = every
        self.health_timeout = health_timeout
        self._restart = restart
        self._wait_healthy = wait_healthy
        self._log = log
        self.points = []

    def describe(self):
        if self.every:
            return f"모든 요청 사이에 {self.action}"
        if self.after:
            return f"요청 {','.join(map(str, self.after))} 뒤 {self.action}"
        return f"가운데 한 번 {self.action}"

    def schedule(self, indices):
        """조건을 실행할 요청 번호 목록 (그 요청이 끝난 직후 실행)."""
        inner = list(indices[:-1])
        if not inner:
            return []
        if self.every:
            return inner
        if self.after:
            chosen = [i for i in inner if i in set(self.after)]
            skipped = sorted(set(self.after) - set(chosen))
            if skipped:
                self._log(f"[{self.name}] 경고: 요청 {skipped} 뒤 {self.action} 건너뜀 "
                          f"(기록 범위 밖이거나 마지막 요청)")
            return chosen
        return [inner[len(indices) // 2 - 1]]

    def before_run(self, indices):
        self.points = self.schedule(indices)
        self._log(f"[{self.name}] {self.action} 지점: 요청 {self.points} 뒤")

    def after_request(self, index):
        if index not in self.points:
            return
        try:
            self._restart(self.container)
            waited = self._wait_healthy(self.health_url, self.health_timeout)
        except (docker_ops.DockerError, TimeoutError) as e:
            raise HookAbort(f"요청 {index} 뒤 {self.action} 실패: {e}") from e
        self._log(f"[{self.name}] 요청 {index} 뒤 {self.operation} → {waited:.1f}초 후 healthz 200")


class ReplaceCondition(RestartCondition):
    """restart 와 같은 지점에서 컨테이너를 docker_ops.recreate 로 새로 만든다."""
    name = "replace"
    action = "교체"
    operation = "컨테이너 재생성"

    def __init__(self, container, health_url, after=None, every=False, health_timeout=30.0,
                 recreate=docker_ops.recreate, wait_healthy=docker_ops.wait_healthy, log=print):
        super().__init__(container, health_url, after=after, every=every, health_timeout=health_timeout,
                         restart=recreate, wait_healthy=wait_healthy, log=log)


def parse_index_list(text):
    """'3,7' → [3, 7]"""
    try:
        values = [int(part) for part in text.split(",") if part.strip()]
    except ValueError:
        raise ValueError(f"요청 번호 목록은 '3,7' 처럼 쉼표로 구분한 정수여야 합니다: {text!r}") from None
    if not values or any(v < 1 for v in values):
        raise ValueError(f"요청 번호는 1 이상이어야 합니다: {text!r}")
    return values


def build(names, container, health_url, restart_after=None, restart_every=False,
          health_timeout=30.0, log=print):
    conditions = []
    for name in names:
        if name == "none":
            conditions.append(NoneCondition())
        elif name == "restart":
            conditions.append(RestartCondition(container, health_url, after=restart_after,
                                               every=restart_every, health_timeout=health_timeout,
                                               log=log))
        elif name == "replace":
            conditions.append(ReplaceCondition(container, health_url, after=restart_after,
                                               every=restart_every, health_timeout=health_timeout,
                                               log=log))
        else:
            raise ValueError(f"지원하지 않는 조건: {name!r} (지원: {', '.join(SUPPORTED)})")
    return conditions
