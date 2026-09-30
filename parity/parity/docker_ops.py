"""docker CLI 호출과 헬스체크 대기를 한곳에 모은 모듈.

다른 모듈은 subprocess 로 docker 를 직접 부르지 않고 여기 함수만 쓴다.
(테스트에서 이 함수들만 가짜로 바꿔 끼우면 docker 없이도 로직을 검증할 수 있다.)
"""
import http.client
import json
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
    if proc.returncode != 0:
        raise DockerError(f"docker {' '.join(args)} 실패 (exit {proc.returncode}): {proc.stderr.strip()}")
    return proc.stdout


def inspect(container):
    return json.loads(docker("inspect", "--type", "container", container))[0]


def image_of(container):
    """컨테이너를 만든 이미지 이름 (예: guestbook:1)."""
    return inspect(container)["Config"]["Image"]


def restart(container):
    docker("restart", container)


def recreate(container):
    """컨테이너를 지우고 같은 설정으로 새로 만든다 → 쓰기 계층이 초기 상태로 돌아간다.

    복원하는 설정: 이미지, 이름, 포트(-p), 이미지 기본값과 다른 환경변수(-e),
    -v 바인드/네임드 볼륨, --tmpfs, --network, 이미지 기본값과 다른 CMD.
    그 밖의 옵션(--mount, --entrypoint, 리소스 제한 등)은 복원하지 않는다.
    네임드 볼륨의 내용은 그대로 남으므로 '초기 상태'가 아닐 수 있다.
    """
    info = inspect(container)
    config, host = info["Config"], info["HostConfig"]
    image = config["Image"]
    image_config = json.loads(docker("image", "inspect", image))[0]["Config"]

    args = ["run", "-d", "--name", container]
    for container_port, bindings in (host.get("PortBindings") or {}).items():
        for b in bindings or []:
            host_ip, host_port = b.get("HostIp") or "", b.get("HostPort") or ""
            args += ["-p", f"{host_ip}:{host_port}:{container_port}" if host_ip else f"{host_port}:{container_port}"]
    image_env = set(image_config.get("Env") or [])
    for env in config.get("Env") or []:
        if env not in image_env:
            args += ["-e", env]
    for bind in host.get("Binds") or []:
        args += ["-v", bind]
    for path, opts in (host.get("Tmpfs") or {}).items():
        args += ["--tmpfs", f"{path}:{opts}" if opts else path]
    network = host.get("NetworkMode") or "default"
    if network not in ("default", "bridge"):
        args += ["--network", network]
    args.append(image)
    if config.get("Cmd") and config.get("Cmd") != image_config.get("Cmd"):
        args += config["Cmd"]

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
