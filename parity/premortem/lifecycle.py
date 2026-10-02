"""조건 실행기: none / restart / replace (IMPLEMENTATION_SPEC 7절).

- 조건마다 같은 이미지 ID·같은 설정으로 새 컨테이너를 만들어 빈 상태에서 시작한다.
- restart: 같은 컨테이너를 재시작한다. 컨테이너 ID와 writable layer가 그대로여야 한다.
- replace: 컨테이너를 지우고 같은 이미지로 새로 만든다. writable layer는 옮기지 않는다.
- 조건 중간에 데이터를 다시 넣어 정상처럼 보이게 하지 않는다.
- 외부 준비 확인이 실패하면 컨테이너 안 health와 listen 주소를 관측한다. 시간 초과 하나로 원인을 정하지 않는다.
"""

import ipaddress
import time
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

from .errors import PremortemError
from .gate import condition_status
from .replay_port import ReplayHookError, ReplayOutcome

PROBE_CODE = "import urllib.request as u;print(u.urlopen('http://127.0.0.1:{port}{path}',timeout=3).status)"


def http_ok(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def _ip_from_proc(hex_ip: str) -> str:
    raw = bytes.fromhex(hex_ip)
    if len(raw) == 4:
        return str(ipaddress.IPv4Address(raw[::-1]))
    groups = b"".join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
    return f"[{ipaddress.IPv6Address(groups).compressed}]"


def parse_listen_addresses(proc_net_text: str, port: int) -> list:
    """/proc/net/tcp·tcp6 내용에서 해당 포트를 LISTEN(0A) 중인 주소를 찾는다."""
    addresses = []
    for line in proc_net_text.splitlines():
        parts = line.split()
        if len(parts) < 4 or parts[0] == "sl" or parts[3] != "0A" or ":" not in parts[1]:
            continue
        hex_ip, hex_port = parts[1].split(":")
        if int(hex_port, 16) == port:
            addresses.append(f"{_ip_from_proc(hex_ip)}:{port}")
    return sorted(set(addresses))


def is_loopback(address: str) -> bool:
    host = address.rsplit(":", 1)[0].strip("[]")
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass
class Container:
    id: str
    port: int


class ConditionRunner:
    def __init__(self, docker, evidence, replay_port, scenario, run_id: str, image_id: str, request_count: int,
                 http_check: Callable[[str], bool] = http_ok, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        self.docker = docker
        self.evidence = evidence
        self.replay_port = replay_port
        self.scenario = scenario
        self.run_id = run_id
        self.image_id = image_id
        self.request_count = request_count
        self.http_check = http_check
        self.sleep = sleep
        self.clock = clock
        self.tracked: list = []  # 이 실행이 만든 모든 컨테이너 ID(정리 대상)
        self.current = None
        self._sequence = 0

    # 전체 흐름 -----------------------------------------------------------
    def run_all(self, required: list, fault_after: list) -> list:
        results, baseline_failed = [], False
        for name in required:
            if self.request_count == 0:
                results.append(self._result(name, "inconclusive", 0, 0, 0, [], "no_recorded_requests: 기록된 요청이 0건"))
                continue
            if baseline_failed:
                results.append(self._result(name, "skipped", self.request_count, 0, 0, [],
                                            "baseline_failed: none이 통과하지 않아 이 조건을 실행하지 않음"))
                continue
            if name != "none" and not fault_after:
                results.append(self._result(name, "inconclusive", self.request_count, 0, 0, [],
                                            "requests_too_few: 기록이 1건 이하라 조건 주입이 의미 없음"))
                continue
            try:
                result = self._run_condition(name, fault_after)
            finally:
                self._remove_current()
            results.append(result)
            if name == "none" and result["status"] != "passed":
                baseline_failed = True
        return results

    def _run_condition(self, name: str, fault_after: list) -> dict:
        self.current = self._start_container(name)
        self.evidence.add(name, "lifecycle",
                          f"{name} 조건 시작: 새 컨테이너 {self.current.id[:12]}, 이미지 {self.image_id[:19]}…, 빈 초기 상태")
        if not self._wait_ready(self.current):
            return self._readiness_failure(name)
        hook = self._hook(name, fault_after)
        try:
            outcome = self.replay_port.replay(self.scenario.session_path, self.scenario.noise_path,
                                              lambda index: f"http://127.0.0.1:{self.current.port}", hook, {})
        except ReplayHookError as error:
            if error.code == "READINESS_FAILED":
                return self._readiness_failure(name, error.partial)
            self.evidence.add(name, "tool_error", f"요청 사이 조건 조작 실패: {error.code} {error.message}")
            mismatches = self._mismatches(name, error.partial)
            return self._result(name, "error", error.partial.expected_count, error.partial.executed_count,
                                error.partial.matched_count, mismatches, f"hook_failed: {error.code}")
        except PremortemError as error:
            # 재생기 자체의 오류. 몇 건을 보냈는지 모르므로 실행·일치 수를 0으로 두고 통과로 보지 않는다.
            self.evidence.add(name, "tool_error", f"재생 도구 오류: {error.code} {error.message}")
            return self._result(name, "error", self.request_count, 0, 0, [], f"replay_failed: {error.code}")
        mismatches = self._mismatches(name, outcome)
        self._collect_final(name)
        status = condition_status(outcome.expected_count, outcome.executed_count, outcome.matched_count, mismatches)
        reason = None
        if status != "passed":
            reason = f"{len(mismatches)}건 불일치 ({outcome.matched_count}/{outcome.expected_count} 일치)"
        if name in self.evidence.truncated_conditions and status == "passed":
            status, reason = "inconclusive", "evidence_truncated: 증거 상한을 넘어 관측 일부를 저장하지 못함"
        return self._result(name, status, outcome.expected_count, outcome.executed_count,
                            outcome.matched_count, mismatches, reason)

    # 컨테이너 조작 -------------------------------------------------------
    def _start_container(self, condition: str) -> Container:
        self._sequence += 1
        container_id = self.docker.create(self.image_id, self.run_id, condition,
                                          self.scenario.container_port, self._sequence)
        self.tracked.append(container_id)
        self.docker.start(container_id)
        info = self.docker.inspect(container_id)
        if info["image"] != self.image_id:
            raise PremortemError("IMAGE_IDENTITY_MISMATCH", "컨테이너가 고정한 이미지 ID로 실행되지 않음")
        return Container(container_id, self.docker.host_port(container_id, self.scenario.container_port))

    def _remove_current(self) -> None:
        if self.current is not None:
            self.docker.remove(self.current.id, self.run_id)
            self.current = None

    def _wait_ready(self, container: Container) -> bool:
        url = f"http://127.0.0.1:{container.port}{self.scenario.readiness_path}"
        deadline = self.clock() + self.scenario.readiness_timeout_sec
        last_state_check = self.clock()
        while self.clock() < deadline:
            if self.http_check(url):
                return True
            if self.clock() - last_state_check >= 1.0:
                last_state_check = self.clock()
                if not self.docker.inspect(container.id)["running"]:
                    return False
            self.sleep(0.25)
        return False

    def _hook(self, name: str, fault_after: list) -> Callable[[int], None]:
        def after_response(index: int) -> None:
            if index not in fault_after:
                return
            if name == "restart":
                self._restart(index)
            elif name == "replace":
                self._replace(index)
        return after_response

    def _restart(self, index: int) -> None:
        before = self.docker.inspect(self.current.id)
        self.docker.restart(self.current.id, self.run_id)
        after = self.docker.inspect(self.current.id)
        if after["id"] != before["id"]:
            raise PremortemError("LIFECYCLE_INVALID", "restart 뒤 컨테이너 ID가 바뀜. restart 시험이 아님")
        if after["image"] != self.image_id:
            raise PremortemError("IMAGE_IDENTITY_MISMATCH", "restart 뒤 이미지 ID가 다름")
        self.current = Container(self.current.id, self.docker.host_port(self.current.id, self.scenario.container_port))
        self.evidence.add("restart", "lifecycle",
                          f"{index}번 응답 뒤 restart: 같은 컨테이너 {after['id'][:12]}, "
                          f"시작 시각 {before['started_at']} → {after['started_at']}, 같은 이미지", request_index=index)
        ready = self._wait_ready(self.current)
        self.evidence.add("restart", "readiness", f"restart 뒤 health {'준비됨' if ready else '응답 없음'}",
                          request_index=index)
        if not ready:
            raise PremortemError("READINESS_FAILED", "restart 뒤 health 준비 확인 실패")

    def _replace(self, index: int) -> None:
        old = self.current
        changed = self.docker.diff(old.id)
        self.evidence.add("replace", "file_change",
                          f"교체 직전 컨테이너 안에서 바뀐 경로 {len(changed)}개: {', '.join(changed[:5])}",
                          request_index=index, artifact_text="\n".join(changed))
        self.docker.remove(old.id, self.run_id)
        self.current = None
        new = self._start_container("replace")
        self.current = new
        if new.id == old.id:
            raise PremortemError("LIFECYCLE_INVALID", "replace 뒤에도 같은 컨테이너 ID")
        self.evidence.add("replace", "lifecycle",
                          f"{index}번 응답 뒤 replace: 컨테이너 {old.id[:12]} 제거 → 새 컨테이너 {new.id[:12]}, "
                          f"같은 이미지 {self.image_id[:19]}…, writable layer 옮기지 않음", request_index=index)
        ready = self._wait_ready(new)
        self.evidence.add("replace", "readiness", f"replace 뒤 health {'준비됨' if ready else '응답 없음'}",
                          request_index=index)
        if not ready:
            raise PremortemError("READINESS_FAILED", "replace 뒤 health 준비 확인 실패")

    # 증거와 결과 ---------------------------------------------------------
    def _readiness_failure(self, name: str, partial: Optional[ReplayOutcome] = None) -> dict:
        # 조건 주입 후 실패는 재생기가 보존한 비교 결과를 유지하고 다음 요청을 readiness 실패로 표시한다.
        expected = partial.expected_count if partial is not None else self.request_count
        executed = partial.executed_count if partial is not None else 0
        matched = partial.matched_count if partial is not None else 0
        request_index = executed + 1
        evidence_index = request_index if partial is not None else None
        mismatches = self._mismatches(name, partial) if partial is not None else []
        info = self.docker.inspect(self.current.id)
        port, path = self.scenario.container_port, self.scenario.readiness_path
        evidence_ids = []
        if not info["running"]:
            evidence_ids.append(self.evidence.add(name, "container_log", f"준비 전에 컨테이너가 종료됨(exit {info['exit_code']})",
                                                  request_index=evidence_index,
                                                  artifact_text=self.docker.logs(self.current.id, 50)))
            reason = f"readiness_failed: 컨테이너 종료(exit {info['exit_code']})"
            summary = f"준비 전에 컨테이너가 종료되어 {request_index}번 요청부터 보내지 못함"
        else:
            probe = self.docker.exec_probe(self.current.id, ["python", "-c", PROBE_CODE.format(port=port, path=path)])
            internal_ok = probe.returncode == 0 and probe.stdout.strip().startswith("2")
            sockets = self.docker.exec_probe(self.current.id, ["cat", "/proc/net/tcp", "/proc/net/tcp6"])
            listen = parse_listen_addresses(sockets.stdout, port) if sockets.returncode == 0 else None
            evidence_ids.append(self.evidence.add(
                name, "readiness",
                f"게시 포트 127.0.0.1:{self.current.port}에서 {self.scenario.readiness_timeout_sec:g}초 동안 health 응답 없음. "
                f"컨테이너 안 루프백 health: {'성공' if internal_ok else '실패'}", request_index=evidence_index))
            listen_text = ", ".join(listen) if listen else ("관측 안 됨" if listen is not None else "확인하지 못함")
            evidence_ids.append(self.evidence.add(name, "listen_socket", f"컨테이너 안 {port}번 포트 LISTEN 주소: {listen_text}",
                                                  request_index=evidence_index))
            self.evidence.add(name, "container_log", "컨테이너 로그(마지막 50줄)", request_index=evidence_index,
                              artifact_text=self.docker.logs(self.current.id, 50))
            if internal_ok and listen and all(is_loopback(address) for address in listen):
                reason = "readiness_failed: 내부 health 성공·외부 실패·루프백 listen 관측 → binding 후보"
            else:
                reason = "readiness_failed: 원인 미확정"
            summary = f"외부에서 health 응답을 받지 못해 {request_index}번 요청부터 보내지 못함"
        mismatches.append({"request_index": request_index, "kind": "readiness", "summary": summary,
                           "evidence_ids": evidence_ids})
        return self._result(name, "failed", expected, executed, matched, mismatches, reason)

    def _mismatches(self, name: str, outcome: ReplayOutcome) -> list:
        mismatches = []
        for result in outcome.results:
            if result.matched:
                continue
            evidence_id = self.evidence.add(name, "http_mismatch", result.summary, request_index=result.request_index)
            mismatches.append({"request_index": result.request_index, "kind": result.kind,
                               "summary": result.summary, "evidence_ids": [evidence_id]})
        return mismatches

    def _collect_final(self, name: str) -> None:
        changed = self.docker.diff(self.current.id)
        self.evidence.add(name, "file_change", f"조건 끝 컨테이너 안에서 바뀐 경로 {len(changed)}개: {', '.join(changed[:5])}",
                          artifact_text="\n".join(changed))

    def _result(self, name, status, expected, executed, matched, mismatches, reason) -> dict:
        return {"name": name, "status": status, "expected_count": expected, "executed_count": executed,
                "matched_count": matched, "mismatches": mismatches, "evidence_ids": self.evidence.ids_for(name),
                "reason": reason}
