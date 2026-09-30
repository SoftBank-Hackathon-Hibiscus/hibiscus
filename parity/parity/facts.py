"""사실(facts) 수집: 앱이 '컨테이너 안에' 남긴 상태를 찾는다.

재생 결과가 어긋났을 때 "왜"를 짐작하는 근거가 된다.
방법: `docker diff` 로 이미지 대비 새로 생기거나 바뀐 파일을 받고, 규칙으로 분류한다.
  - sqlite       : 파일 앞 16바이트가 "SQLite format 3\\0" (확장자가 아니라 내용으로 판별)
  - local_upload : uploads/upload/media 디렉터리 아래 파일 → 디렉터리 하나당 사실 1개
  - local_file   : 그 밖에 앱이 쓴 파일

사실 하나의 형식:
  {"kind": "sqlite", "path": "/app/data/data.db", "storage": "container_layer",
   "evidence": "docker diff A /app/data/data.db; header 'SQLite format 3'"}
storage=container_layer 의 의미: `docker restart` 로는 남지만, 컨테이너를 지우고 다시 만들면
(재배포, 스케일아웃 시 새 인스턴스) 사라지거나 인스턴스끼리 공유되지 않는다.

한계: 볼륨/tmpfs 안의 파일과 프로세스 메모리 상태(세션 등)는 docker diff 에 안 보인다.
"""
import posixpath
import re

from . import docker_ops

SQLITE_MAGIC = b"SQLite format 3\x00"
SQLITE_SIDE_SUFFIXES = ("-journal", "-wal", "-shm")
UPLOAD_DIR_RE = re.compile(r"^(.*?/(?:uploads?|media))(?:/|$)", re.IGNORECASE)
IGNORED_PREFIXES = ("/tmp/", "/var/tmp/", "/run/", "/proc/", "/sys/", "/dev/",
                    "/root/.cache/", "/var/cache/", "/var/log/", "/etc/")
KIND_ORDER = {"sqlite": 0, "local_upload": 1, "local_file": 2}


def _leaves(changes):
    """추가/변경된 경로 중 '다른 변경 경로의 부모 디렉터리'가 아닌 것 = 실제로 쓰인 파일."""
    parents = {posixpath.dirname(p) for _, p in changes}
    return [(p, kind) for kind, p in changes if kind in ("A", "C") and p not in parents]


def classify(changes, read_head):
    """docker diff 결과를 사실 목록으로. read_head(path) → 파일 앞부분 bytes | None"""
    facts, uploads = [], {}
    for path, kind in _leaves(changes):
        if path.startswith(IGNORED_PREFIXES) or "/__pycache__/" in path:
            continue
        if path.endswith(SQLITE_SIDE_SUFFIXES):
            continue  # 저널 파일은 본 DB 사실에 포함된다고 본다
        head = read_head(path)
        if head is not None and head.startswith(SQLITE_MAGIC):
            facts.append({"kind": "sqlite", "path": path, "storage": "container_layer",
                          "evidence": f"docker diff {kind} {path}; header 'SQLite format 3'"})
            continue
        m = UPLOAD_DIR_RE.match(path)
        if m:
            uploads.setdefault(m.group(1), []).append(path)
            continue
        facts.append({"kind": "local_file", "path": path, "storage": "container_layer",
                      "evidence": f"docker diff {kind} {path}"})
    for directory, files in uploads.items():
        facts.append({"kind": "local_upload", "path": directory, "storage": "container_layer",
                      "evidence": f"docker diff: {len(files)} file(s) written under {directory}"})
    facts.sort(key=lambda f: (KIND_ORDER.get(f["kind"], 9), f["path"]))
    return facts


def collect(container):
    return classify(docker_ops.diff(container),
                    lambda path: docker_ops.read_head(container, path))
