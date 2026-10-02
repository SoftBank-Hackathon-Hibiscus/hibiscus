"""docker CLI 호출과 헬스체크 대기를 한곳에 모은 모듈.

다른 모듈은 subprocess 로 docker 를 직접 부르지 않고 여기 함수만 쓴다.
(테스트에서 이 함수들만 가짜로 바꿔 끼우면 docker 없이도 로직을 검증할 수 있다.)
"""
import http.client
import ipaddress
import json
import re
import subprocess
import tarfile
import time
import urllib.error
import urllib.request


class DockerError(RuntimeError):
    pass


def docker(*args, timeout=120):
    """`docker <args>` 를 실행하고 stdout 을 돌려준다. 실패하면 DockerError."""
    try:
        proc = subprocess.run(
            ["docker", *args], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except FileNotFoundError:
        raise DockerError("docker 명령을 찾을 수 없습니다 (Docker 설치/PATH 확인)") from None
    except subprocess.TimeoutExpired:
        raise DockerError("Docker 명령이 제한 시간 안에 끝나지 않았습니다") from None
    except OSError:
        raise DockerError("Docker 명령을 실행하지 못했습니다") from None
    if proc.returncode != 0:
        # run의 -e 값이나 Docker stderr에는 비밀값이 포함될 수 있다.
        raise DockerError(f"Docker 명령 실패 (exit {proc.returncode}); 원본 인자와 오류 출력은 기록하지 않습니다")
    return proc.stdout


def inspect(container):
    return json.loads(docker("inspect", "--type", "container", container))[0]


def image_of(container):
    """컨테이너를 만든 이미지 이름 (예: guestbook:1)."""
    return inspect(container)["Config"]["Image"]


def image_id_of(container):
    """실행 중인 컨테이너의 실제 로컬 이미지 ID. 레지스트리 digest는 아니다."""
    image = inspect(container).get("Image")
    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise DockerError("컨테이너의 실제 이미지 ID를 확인하지 못했습니다")
    return image


def _require_recreate(condition, message):
    if not condition:
        raise DockerError("재생성 중단(기존 컨테이너 유지): " + message)


def _recreate_ports(host):
    """고정 TCP 포트만 허용한다. 잘못된 값은 삭제 명령보다 먼저 거부한다."""
    bindings = host.get("PortBindings")
    _require_recreate(isinstance(bindings, dict) and bool(bindings), "게시된 고정 포트가 필요합니다")
    args = []
    for port, addresses in bindings.items():
        match = re.fullmatch(r"([0-9]+)/tcp", port) if isinstance(port, str) else None
        _require_recreate(match is not None and 1 <= int(match.group(1)) <= 65535,
                          "TCP 컨테이너 포트 형식이 잘못되었습니다")
        _require_recreate(isinstance(addresses, list) and bool(addresses), "게시 포트 설정이 비어 있습니다")
        for binding in addresses:
            _require_recreate(isinstance(binding, dict), "게시 포트 설정 형식이 잘못되었습니다")
            host_port, host_ip = binding.get("HostPort"), binding.get("HostIp") or ""
            _require_recreate(isinstance(host_port, str) and host_port.isascii() and host_port.isdigit()
                              and 1 <= int(host_port) <= 65535,
                              "자동 할당 대신 1~65535의 고정 호스트 포트를 지정해야 합니다")
            _require_recreate(isinstance(host_ip, str), "호스트 IP 형식이 잘못되었습니다")
            if host_ip:
                try:
                    parsed = ipaddress.ip_address(host_ip)
                except ValueError:
                    raise DockerError("재생성 중단(기존 컨테이너 유지): 호스트 IP 형식이 잘못되었습니다") from None
                host_ip = f"[{host_ip}]" if parsed.version == 6 else host_ip
            args += ["-p", f"{host_ip}:{host_port}:{port}" if host_ip else f"{host_port}:{port}"]
    return args


def _recreate_settings(info, host):
    """샘플 앱과 기본 bridge 실행기의 설정 범위. 지원하지 않는 구성은 먼저 거부한다."""
    _require_recreate(host.get("NetworkMode", "default") in ("", "default", "bridge"),
                      "사용자 네트워크·host/container 네트워크는 지원하지 않습니다")
    networks = (info.get("NetworkSettings") or {}).get("Networks") or {}
    _require_recreate(isinstance(networks, dict) and all(name == "bridge" for name in networks),
                      "기본 bridge 이외의 연결은 지원하지 않습니다")
    for endpoint in networks.values():
        _require_recreate(isinstance(endpoint, dict) and not any(endpoint.get(key) for key in
                          ("IPAMConfig", "Aliases", "Links", "DriverOpts")),
                          "고정 내부 IP·네트워크 별칭 설정은 지원하지 않습니다")
    for key in ("Mounts", "VolumesFrom", "Privileged", "CapAdd", "Devices", "DeviceRequests",
                "Links", "Dns", "DnsSearch", "DnsOptions", "ExtraHosts", "GroupAdd", "PublishAllPorts",
                "AutoRemove", "CpuPeriod", "CpuQuota", "CpuShares", "CpuRealtimePeriod",
                "CpuRealtimeRuntime", "CpusetCpus", "CpusetMems", "MemoryReservation", "Ulimits",
                "Sysctls", "DeviceCgroupRules", "CgroupParent"):
        _require_recreate(not host.get(key), f"{key} 사용자 설정은 현재 재생성에서 지원하지 않습니다")
    for key in ("PidMode", "UTSMode", "UsernsMode"):
        _require_recreate(not host.get(key), f"{key} 설정은 지원하지 않습니다")
    _require_recreate(host.get("IpcMode", "private") in ("", "private"), "공유 IPC 설정은 지원하지 않습니다")
    _require_recreate(host.get("Runtime", "runc") in ("", "runc"), "사용자 컨테이너 runtime은 지원하지 않습니다")
    restart_policy = host.get("RestartPolicy") or {}
    _require_recreate(isinstance(restart_policy, dict) and restart_policy.get("Name", "no") in ("", "no"),
                      "자동 재시작 정책은 지원하지 않습니다")

    args = []
    for key, flag in (("CapDrop", "--cap-drop"), ("SecurityOpt", "--security-opt")):
        values = host.get(key) or []
        _require_recreate(isinstance(values, list) and all(isinstance(value, str) and value for value in values),
                          f"{key} 형식이 잘못되었습니다")
        for value in values:
            args += [flag, value]
    for key, flag, minimum in (("Memory", "--memory", 0), ("MemorySwap", "--memory-swap", -1),
                               ("PidsLimit", "--pids-limit", -1)):
        value = host.get(key)
        _require_recreate(value is None or (type(value) is int and value >= minimum), f"{key} 형식이 잘못되었습니다")
        if value:
            args += [flag, str(value)]
    nano_cpus = host.get("NanoCpus", 0)
    _require_recreate(type(nano_cpus) is int and nano_cpus >= 0, "NanoCpus 형식이 잘못되었습니다")
    if nano_cpus:
        whole, fractional = divmod(nano_cpus, 1_000_000_000)
        args += ["--cpus", f"{whole}.{fractional:09d}".rstrip("0").rstrip(".")]
    swappiness = host.get("MemorySwappiness")
    if swappiness is not None:
        _require_recreate(type(swappiness) is int and 0 <= swappiness <= 100,
                          "MemorySwappiness 형식이 잘못되었습니다")
        args += ["--memory-swappiness", str(swappiness)]
    for key, flag in (("ReadonlyRootfs", "--read-only"), ("Init", "--init"), ("OomKillDisable", "--oom-kill-disable")):
        if host.get(key):
            args.append(flag)
    shm = host.get("ShmSize")
    if shm not in (None, 0, 67108864):
        _require_recreate(type(shm) is int and shm > 0, "ShmSize 형식이 잘못되었습니다")
        args += ["--shm-size", str(shm)]
    return args


def restart(container):
    docker("restart", container)


def recreate(container):
    """컨테이너를 지우고 같은 설정으로 새로 만든다 → 쓰기 계층이 초기 상태로 돌아간다.

    지원 범위: 실제 이미지 ID, 이름, 고정 TCP 포트, 기본 bridge, 환경변수,
    명시적 -v/--tmpfs, 라벨, cap-drop/security-opt, memory/swap/pids/cpus,
    user/workingdir/entrypoint/CMD. 외부 볼륨 내용은 초기화하지 않는다.
    --mount/익명 볼륨/사용자 네트워크·내부 IP/장치/추가 capability/자동 재시작은
    삭제 전에 거부한다. 범용 Docker 설정 복제기가 아니며 샘플 앱·기본 실행기용이다.
    """
    info = inspect(container)
    config, host = info["Config"], info["HostConfig"]

    # 이름표가 바뀌어도 기존 컨테이너와 같은 이미지로 재생성한다.
    image = info["Image"]
    _require_recreate(isinstance(image, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image),
                      "실제 이미지 ID가 필요합니다")
    name = info.get("Name", container)
    _require_recreate(isinstance(name, str), "컨테이너 이름 형식이 잘못되었습니다")
    name = name.lstrip("/")
    _require_recreate(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name),
                      "컨테이너 이름 형식이 잘못되었습니다")
    port_args = _recreate_ports(host)
    safety_args = _recreate_settings(info, host)

    image_config = json.loads(docker("image", "inspect", image))[0]["Config"]

    args = ["run", "-d", "--name", name] + port_args + safety_args
    for key, value in (config.get("Labels") or {}).items():
        _require_recreate(isinstance(key, str) and isinstance(value, str), "라벨 형식이 잘못되었습니다")
        args += ["--label", f"{key}={value}"]
    image_env = set(image_config.get("Env") or [])
    current_env = config.get("Env") or []
    _require_recreate(isinstance(current_env, list) and all(isinstance(env, str) and "=" in env for env in current_env),
                      "환경변수 형식이 잘못되었습니다")
    image_names = {env.split("=", 1)[0] for env in image_env}
    _require_recreate(image_names <= {env.split("=", 1)[0] for env in current_env},
                      "이미지 기본 환경변수를 제거한 구성은 지원하지 않습니다")
    for env in config.get("Env") or []:
        if env not in image_env:
            args += ["-e", env]
    bind_destinations = set()
    for bind in host.get("Binds") or []:
        _require_recreate(isinstance(bind, str) and ":" in bind, "명시적인 원본·대상 경로가 있는 -v만 지원합니다")
        parts = bind.split(":")
        destination = parts[-1] if parts[-1].startswith("/") else parts[-2]
        _require_recreate(destination.startswith("/"), "볼륨 대상은 컨테이너 절대 경로여야 합니다")
        bind_destinations.add(destination)
        args += ["-v", bind]
    tmpfs = host.get("Tmpfs") or {}
    for path, opts in tmpfs.items():
        _require_recreate(isinstance(path, str) and path.startswith("/") and isinstance(opts, str),
                          "tmpfs 설정 형식이 잘못되었습니다")
        args += ["--tmpfs", f"{path}:{opts}" if opts else path]
    for mount in info.get("Mounts") or []:
        _require_recreate(isinstance(mount, dict) and (
            (mount.get("Type") in ("bind", "volume") and mount.get("Destination") in bind_destinations)
            or (mount.get("Type") == "tmpfs" and mount.get("Destination") in tmpfs)),
            "복원할 수 없는 마운트 또는 익명 볼륨이 있습니다")
    image_volumes = image_config.get("Volumes") or {}
    _require_recreate(set(image_volumes) <= bind_destinations | set(tmpfs), "이미지의 익명 볼륨은 지원하지 않습니다")
    for key, flag in (("User", "--user"), ("WorkingDir", "--workdir")):
        value = config.get(key) or ""
        if value != (image_config.get(key) or ""):
            _require_recreate(isinstance(value, str) and bool(value), f"기본 {key}를 빈 값으로 지우는 설정은 지원하지 않습니다")
            args += [flag, value]
    entrypoint = config.get("Entrypoint") or []
    command = config.get("Cmd") or []
    _require_recreate(all(isinstance(value, list) and all(isinstance(item, str) for item in value)
                          for value in (entrypoint, command)), "Entrypoint/Cmd 형식이 잘못되었습니다")
    entry_changed = entrypoint != (image_config.get("Entrypoint") or [])
    if entry_changed:
        args += ["--entrypoint", entrypoint[0] if entrypoint else ""]
    _require_recreate(command or not image_config.get("Cmd") or entry_changed,
                      "기본 CMD만 빈 값으로 지우는 설정은 지원하지 않습니다")
    args.append(image)
    if entry_changed:
        args += entrypoint[1:] + command
    elif command != (image_config.get("Cmd") or []):
        args += command

    docker("rm", "-f", container)
    docker(*args)


def diff(container):
    """`docker diff` → [(변경종류, 경로)]. 변경종류: A(추가) C(변경) D(삭제)."""
    changes = []
    for line in docker("diff", container).splitlines():
        kind, _, path = line.strip().partition(" ")
        if kind and path:
            changes.append((kind, path))
    return changes


def read_head(container, path, n=16):
    """컨테이너 안 파일의 앞 n 바이트. `docker cp` 는 tar 스트림을 내보내므로
    컨테이너 안에 head/cat 같은 도구가 없어도 동작한다. 실패하면 None."""
    try:
        proc = subprocess.Popen(
            ["docker", "cp", f"{container}:{path}", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return None
    try:
        tar = tarfile.open(fileobj=proc.stdout, mode="r|")
        member = tar.next()
        if member is None or not member.isfile():
            return None
        return tar.extractfile(member).read(n)
    except (tarfile.TarError, OSError):
        return None
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def wait_healthy(url, timeout=30.0, interval=0.25, ssl_context=None):
    """url 이 200 을 돌려줄 때까지 기다린다. 걸린 초를 돌려주고, 시간 초과면 TimeoutError."""
    start = time.monotonic()
    last_error = "no response"
    while True:
        try:
            with urllib.request.urlopen(url, timeout=2, context=ssl_context) as resp:
                if resp.status == 200:
                    return time.monotonic() - start
                last_error = f"HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            last_error = f"HTTP {e.code}"
        except (OSError, http.client.HTTPException) as e:
            last_error = f"{type(e).__name__}: {e}"
        if time.monotonic() - start >= timeout:
            raise TimeoutError(f"{url} 가 {timeout:.0f}초 안에 200 을 돌려주지 않음 (마지막: {last_error})")
        time.sleep(interval)
