"""실행 환경 점검. 비밀값은 읽거나 출력하지 않고 존재 여부만 본다.

상태 값: available / missing / incompatible / unchecked
"""

import os
import shutil
import sys
from pathlib import Path
from typing import Optional

from . import __version__
from .errors import PremortemError
from .process import CommandRunner, SubprocessRunner

_SKIP_DIRS = {".git", "node_modules", ".runs", "__pycache__", ".venv", "venv"}


def _check(status: str, reason: str, **extra) -> dict:
    return {"status": status, "reason": reason, **extra}


def _module_version(name: str) -> Optional[str]:
    try:
        module = __import__(name)
    except ImportError:
        return None
    return str(getattr(module, "__version__", "unknown"))


def find_team_modules(repo_root: Path, max_depth: int = 3) -> dict:
    """문서상 이름으로 팀 모듈 흔적을 찾는다. 못 찾았다고 팀 코드가 없다고 단정하지 않는다."""
    found = {"replay": [], "policy": [], "contracts": []}
    root = repo_root.resolve()
    for current, dirs, files in os.walk(root):
        depth = len(Path(current).relative_to(root).parts)
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and depth < max_depth]
        rel = Path(current).relative_to(root).as_posix()
        name = Path(current).name
        if name == "guestbook-parity" or (name == "parity" and "__main__.py" in files):
            found["replay"].append(rel)
        if name in ("policy", "policy-engine") and "package.json" in files:
            found["policy"].append(rel)
        if any(f.startswith("test_result") and f.endswith(".json") for f in files):
            found["contracts"].append(rel)
    return found


def run_doctor(runner: Optional[CommandRunner] = None, repo_root: Optional[Path] = None) -> dict:
    runner = runner or SubprocessRunner()
    repo_root = repo_root or Path.cwd()
    checks = {}

    version = ".".join(map(str, sys.version_info[:3]))
    checks["python"] = (_check("available", "3.11 이상", version=version) if sys.version_info >= (3, 11)
                        else _check("incompatible", "Python 3.11 이상 필요", version=version))

    if shutil.which("docker") is None:
        checks["docker_cli"] = _check("missing", "docker 실행 파일 없음")
        checks["docker_daemon"] = _check("unchecked", "docker CLI가 없어 확인하지 않음")
    else:
        checks["docker_cli"] = _check("available", "docker 실행 파일 있음")
        try:
            result = runner.run(["docker", "version", "--format", "{{.Server.Version}}"], 20)
            if result.returncode == 0 and result.stdout.strip():
                checks["docker_daemon"] = _check("available", "daemon 응답", version=result.stdout.strip())
            else:
                first = (result.stderr.strip().splitlines() or ["응답 없음"])[0][:200]
                checks["docker_daemon"] = _check("missing", f"daemon 응답 실패: {first}")
        except PremortemError as error:
            checks["docker_daemon"] = _check("missing", error.message)

    checks["git"] = (_check("available", "git 실행 파일 있음") if shutil.which("git")
                     else _check("missing", "git 실행 파일 없음"))

    js = _module_version("jsonschema")
    checks["jsonschema"] = (_check("available", "내부 계약 스키마 검사 가능", version=js) if js
                            else _check("missing", "스키마 검사를 '미검사'로 표시함"))

    sdk = _module_version("anthropic")
    checks["anthropic_sdk"] = (_check("available", "live AI provider 사용 가능", version=sdk) if sdk
                               else _check("missing", "--ai live에만 필요. 나머지 기능은 동작"))

    # 값은 읽지 않고 존재 여부만 본다.
    checks["ai_credentials"] = (_check("available", "ANTHROPIC_API_KEY 설정됨") if os.environ.get("ANTHROPIC_API_KEY")
                                else _check("missing", "ANTHROPIC_API_KEY 없음: live AI 미실행"))
    model = os.environ.get("PREMORTEM_LLM_MODEL")
    checks["ai_model"] = (_check("available", "PREMORTEM_LLM_MODEL 설정됨", model=model) if model
                          else _check("missing", "PREMORTEM_LLM_MODEL 없음: live AI 미실행"))

    team = find_team_modules(repo_root)
    for key, label in (("replay", "윤선님 기록·재생 모듈"), ("policy", "류진님 정책 모듈"), ("contracts", "팀 공통 test_result 계약")):
        paths = team[key]
        checks[f"team_{key}"] = (_check("available", f"{label} 후보 발견", paths=paths) if paths
                                 else _check("missing", f"{label}: 문서상 이름으로 찾지 못함(다른 이름일 수 있음)"))

    return {"tool": "premortem", "version": __version__, "checks": checks}
