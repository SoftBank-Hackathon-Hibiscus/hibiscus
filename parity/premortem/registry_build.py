"""커밋된 소스를 빌드·업로드하고 index digest와 로컬 이미지의 연결을 확인한다."""

import fnmatch
import hashlib
import re
import shutil
import tarfile
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .errors import PremortemError
from .jsonio import load_json, loads_strict, write_json_atomic
from .paths import safe_relative, validate_run_id
from .process import CommandRunner
from .redact import redact
from .snapshot import EXCLUDED_DIRS, EXCLUDED_FILES, tree_hash, tree_listing, verify_source_tree

_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_REPO = re.compile(r"(?:localhost|[a-z0-9][a-z0-9.-]*)(?::[0-9]{1,5})?/"
                   r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*\Z")
_INDEX_TYPES = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}
_MANIFEST_TYPES = {"application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"}
_PLATFORMS = {"linux/amd64", "linux/arm64"}


def _command(runner, args, timeout=60):
    result = runner.run(args, timeout)
    if result.returncode:
        detail = redact((result.stderr or result.stdout).strip()[-2000:])
        raise PremortemError("BUILD_COMMAND_FAILED", f"{' '.join(args[:3])} 실패: {detail}")
    return result.stdout


def _digest(value):
    if not isinstance(value, str) or not _DIGEST.fullmatch(value):
        raise PremortemError("BUILD_IDENTITY_INVALID", "sha256 digest가 없거나 형식이 잘못됨")
    return value


def _snapshot_commit(app: Path, destination: Path, runner: CommandRunner) -> dict:
    """작업 폴더 대신 지정 커밋의 archive를 사용한다. ignored 파일은 빌드에 넣지 않는다."""
    git = ["git", "-C", str(app)]
    status = _command(runner, git + ["status", "--porcelain", "--untracked-files=all", "--", "."])
    if status.strip():
        raise PremortemError("SOURCE_DIRTY", "앱 폴더의 변경을 커밋한 뒤 빌드해 주세요")
    commit = _command(runner, git + ["rev-parse", "--verify", "HEAD^{commit}"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit):
        raise PremortemError("BUILD_IDENTITY_INVALID", "소스 커밋을 확인할 수 없음")
    prefix = _command(runner, git + ["rev-parse", "--show-prefix"]).strip()
    root = _command(runner, git + ["rev-parse", "--show-toplevel"]).strip()
    git = ["git", "-C", root]
    tree = commit + (":" + prefix.rstrip("/") if prefix else "")
    entries = _command(runner, git + ["ls-tree", "-r", tree])
    if any(line.startswith("160000 ") for line in entries.splitlines()):
        raise PremortemError("INPUT_INVALID", "앱 폴더의 Git submodule은 아직 빌드할 수 없음")
    destination.mkdir()
    excludes = []
    # archive에는 제외 대상도 들어갈 수 있어 임시 폴더에만 두고 즉시 지운다.
    with tempfile.TemporaryDirectory(prefix="premortem-source-") as tmp:
        archive = Path(tmp) / "source.tar"
        _command(runner, git + ["archive", "--format=tar", "--output", str(archive), tree])
        with tarfile.open(archive) as handle:
            for member in handle:
                path = safe_relative(member.name.rstrip("/"))
                if (any(part in EXCLUDED_DIRS for part in path.parts)
                        or any(fnmatch.fnmatch(path.name, pattern) for pattern in EXCLUDED_FILES)):
                    excludes.append(member.name)
                    continue
                if member.isdir():
                    continue
                if not member.isfile():
                    excludes.append(member.name + " (일반 파일 아님)")
                    continue
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with handle.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                # 실행 파일 여부도 커밋 기준으로 복원한다. setuid 등의 비트는 받지 않는다.
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    if not (destination / "Dockerfile").is_file():
        raise PremortemError("INPUT_INVALID", "커밋된 앱 폴더에 Dockerfile이 필요함")
    files, _ = tree_listing(destination)
    return {"commit": commit, "subdir": prefix.rstrip("/"), "tree_sha256": tree_hash(files),
            "excludes": sorted(excludes), "context": "committed-files"}


def _read_manifest(runner, repository, digest):
    raw = _command(runner, ["docker", "buildx", "imagetools", "inspect", "--raw", f"{repository}@{digest}"])
    # imagetools 버전에 따라 출력 끝에 개행이 하나 붙는다. JSON을 재직렬화하면 digest가 달라진다.
    candidates = [raw, raw[:-1]] if raw.endswith("\n") else [raw]
    if not any("sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest() == digest for value in candidates):
        raise PremortemError("BUILD_IDENTITY_INVALID", "레지스트리 manifest의 내용과 digest가 다름")
    manifest = loads_strict(raw)
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2:
        raise PremortemError("BUILD_IDENTITY_INVALID", "레지스트리 manifest 형식이 잘못됨")
    return manifest


def _verify_index(runner, repository, digest, platforms):
    index = _read_manifest(runner, repository, digest)
    if index.get("mediaType") not in _INDEX_TYPES or not isinstance(index.get("manifests"), list):
        raise PremortemError("BUILD_IDENTITY_INVALID", "최상위 digest가 image index가 아님")
    children = {}
    for descriptor in index["manifests"]:
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get("platform"), dict):
            raise PremortemError("BUILD_IDENTITY_INVALID", "index의 platform 정보가 잘못됨")
        p = descriptor["platform"]
        platform = f"{p.get('os')}/{p.get('architecture')}"
        # BuildKit provenance는 실행 이미지와 별도 descriptor로 들어간다.
        if (platform == "unknown/unknown" and isinstance(descriptor.get("annotations"), dict)
                and descriptor["annotations"].get("vnd.docker.reference.type") == "attestation-manifest"):
            continue
        variants = (None, "", "v8") if platform == "linux/arm64" else (None, "")
        if platform not in platforms or platform in children or p.get("variant") not in variants:
            raise PremortemError("BUILD_IDENTITY_INVALID", "요청하지 않았거나 중복된 platform이 index에 있음")
        child_digest = _digest(descriptor.get("digest"))
        child = _read_manifest(runner, repository, child_digest)
        if child.get("mediaType") not in _MANIFEST_TYPES or not isinstance(child.get("config"), dict):
            raise PremortemError("BUILD_IDENTITY_INVALID", "platform manifest 형식이 잘못됨")
        children[platform] = {"manifest_digest": child_digest, "config_digest": _digest(child["config"].get("digest"))}
    if set(children) != set(platforms):
        raise PremortemError("BUILD_IDENTITY_INVALID", "index에 요청한 platform이 모두 들어 있지 않음")
    return children


def _verify_local_image(local, index_digest, platform, child, labels):
    """Docker's classic store returns a config ID; containerd returns a descriptor ID.

    Accept only identities in the already hash-verified index/manifest chain.
    An index match alone must not bypass the selected platform or source labels.
    """
    if not isinstance(local, dict):
        raise PremortemError("BUILD_IDENTITY_INVALID", "pull한 이미지 정보가 객체가 아님")
    identities = {child["config_digest"]: "config", child["manifest_digest"]: "manifest",
                  index_digest: "index"}
    local_id = _digest(local.get("Id"))
    kind = identities.get(local_id)
    if kind is None:
        raise PremortemError("BUILD_IDENTITY_INVALID",
                             "로컬 이미지 ID가 검증한 index·platform manifest·config 중 어느 것과도 일치하지 않음")
    descriptor = local.get("Descriptor")
    if descriptor is not None:
        media_types = _INDEX_TYPES if kind == "index" else _MANIFEST_TYPES
        if (not isinstance(descriptor, dict) or descriptor.get("digest") != local_id
                or kind == "config" or descriptor.get("mediaType") not in media_types):
            raise PremortemError("BUILD_IDENTITY_INVALID", "로컬 이미지 descriptor와 ID가 다름")
    config = local.get("Config") or {}
    actual_labels = config.get("Labels") if isinstance(config, dict) else None
    variants = (None, "", "v8") if platform == "linux/arm64" else (None, "")
    if (f"{local.get('Os')}/{local.get('Architecture')}" != platform
            or local.get("Variant") not in variants
            or not isinstance(actual_labels, dict)
            or any(actual_labels.get(key) != value for key, value in labels.items())):
        raise PremortemError("BUILD_IDENTITY_INVALID", "로컬 이미지의 platform 또는 빌드 소스 라벨이 다름")
    return kind


def build_and_push(*, app: Path, image_repo: str, out_dir: Path, runner: CommandRunner,
                   run_id: str, platforms=("linux/amd64", "linux/arm64"), builder=None,
                   timeout=900) -> dict:
    """성공 manifest는 모든 검증 후에만 쓴다. 실패한 실행 폴더도 재사용하지 않는다."""
    app, out_dir = Path(app).resolve(), Path(out_dir).resolve()
    validate_run_id(run_id)
    host = image_repo.split("/", 1)[0]
    if not _REPO.fullmatch(image_repo) or not ("." in host or ":" in host or host == "localhost"):
        raise PremortemError("INPUT_INVALID", "--image-repo에는 태그 없이 registry/경로를 지정해 주세요")
    if not platforms or len(set(platforms)) != len(platforms) or not set(platforms) <= _PLATFORMS:
        raise PremortemError("INPUT_INVALID", "platform은 linux/amd64,linux/arm64 중 중복 없이 지정해 주세요")
    if not app.is_dir() or out_dir == app or app in out_dir.parents or timeout <= 0:
        raise PremortemError("INPUT_INVALID", "앱 폴더와 양수 timeout이 필요하며 결과 폴더는 앱 밖에 두어야 함")
    try:
        out_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise PremortemError("RUN_EXISTS", f"기존 빌드 결과 폴더를 덮어쓰지 않음: {out_dir}") from None
    except OSError as error:
        raise PremortemError("BUILD_IO_FAILED", f"빌드 결과 폴더를 만들 수 없음: {error}") from error
    try:
        source = _snapshot_commit(app, out_dir / "source", runner)
        native = _command(runner, ["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"]).strip()
        native = native.replace("/x86_64", "/amd64").replace("/aarch64", "/arm64")
        if native not in platforms:
            raise PremortemError("INPUT_INVALID", f"로컬 검증을 위해 Docker 호스트 platform({native})을 포함해 주세요")
        tag = f"{image_repo}:build-{run_id}-{uuid.uuid4().hex[:8]}"
        labels = {"org.opencontainers.image.revision": source["commit"],
                  "premortem.source_tree_sha256": source["tree_sha256"], "premortem.run_id": run_id}
        metadata_path = out_dir / "buildx-metadata.json"
        args = ["docker", "buildx", "build"]
        if builder:
            args += ["--builder", builder]
        args += ["--platform", ",".join(platforms), "--push", "--provenance=mode=min",
                 "--metadata-file", str(metadata_path), "--tag", tag]
        for key, value in labels.items():
            args += ["--label", f"{key}={value}"]
        args.append(str(out_dir / "source"))
        _command(runner, args, timeout)
        verify_source_tree(out_dir / "source", source["tree_sha256"])
        metadata = load_json(metadata_path)
        digest = _digest(metadata.get("containerimage.digest") if isinstance(metadata, dict) else None)
        # 태그는 다른 빌드가 바꿀 수 있으므로 이후 조회와 pull은 digest만 쓴다.
        children = _verify_index(runner, image_repo, digest, platforms)
        reference = f"{image_repo}@{digest}"
        _command(runner, ["docker", "pull", "--platform", native, reference], timeout)
        images = loads_strict(_command(runner, ["docker", "image", "inspect", reference]))
        if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
            raise PremortemError("BUILD_IDENTITY_INVALID", "pull한 이미지 정보를 확인할 수 없음")
        local = images[0]
        identity_kind = _verify_local_image(local, digest, native, children[native], labels)
        result = {"schema_version": "premortem.build.v1", "run_id": run_id,
                  "created_at": datetime.now(timezone.utc).isoformat(), "source": source,
                  "image": {"reference": reference, "build_tag": tag, "registry_digest": digest,
                            "platforms": children, "platform": native, "local_image_id": local["Id"],
                            "local_image_id_kind": identity_kind,
                            "source_build_link_verified": True, "registry_link_verified": True}}
        # 레지스트리 조회와 pull 동안 보관된 소스가 바뀌어도 성공 기록을 남기지 않는다.
        verify_source_tree(out_dir / "source", source["tree_sha256"])
        write_json_atomic(out_dir / "build_manifest.json", result)
        return result
    except (OSError, tarfile.TarError) as error:
        failure = PremortemError("BUILD_IO_FAILED", f"빌드 파일 처리 실패: {error}")
        write_json_atomic(out_dir / "build_error.json", {"error_code": failure.code, "message": failure.message})
        raise failure from error
    except PremortemError as error:
        write_json_atomic(out_dir / "build_error.json", {"error_code": error.code, "message": error.message})
        raise
