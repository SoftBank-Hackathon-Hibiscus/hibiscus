"""빌드 기록을 소비할 때 레지스트리·소스·로컬 이미지를 다시 대조한다."""
import re
from pathlib import Path

from .errors import PremortemError
from .jsonio import load_json, loads_strict
from .paths import validate_run_id
from .registry_build import _command, _digest, _verify_index, _verify_local_image, _REPO
from .snapshot import tree_hash, tree_listing


def verify_build(path: Path, runner, *, run_id=None, revision=None, digest=None):
    path = Path(path).resolve()
    build = load_json(path)
    try:
        if build['schema_version'] != 'premortem.build.v1':
            raise ValueError('빌드 기록 버전이 다름')
        validate_run_id(build['run_id'])
        source, image = build['source'], build['image']
        if not re.fullmatch(r'[0-9a-f]{40}', source['commit']):
            raise ValueError('전체 소스 커밋 SHA가 필요함')
        actual_digest = _digest(image['registry_digest'])
        repo, separator, ref_digest = image['reference'].partition('@')
        if not separator or not _REPO.fullmatch(repo) or ref_digest != actual_digest:
            raise ValueError('이미지 참조와 index digest가 다름')
        if image['registry_link_verified'] is not True or image['source_build_link_verified'] is not True:
            raise ValueError('완료된 빌드 기록이 아님')
        for expected, actual in ((run_id, build['run_id']), (revision, source['commit']), (digest, actual_digest)):
            if expected is not None and expected != actual:
                raise ValueError('요청한 run_id·source_revision·digest와 빌드 기록이 다름')
        files, excludes = tree_listing(path.parent / 'source')
        if not files or excludes or tree_hash(files) != source['tree_sha256']:
            raise ValueError('빌드 소스 복사본이 바뀌었거나 없음')
        platforms = image['platforms']
        if not isinstance(platforms, dict) or not platforms or not set(platforms) <= {'linux/amd64', 'linux/arm64'}:
            raise ValueError('빌드 platform 정보가 잘못됨')
        children = _verify_index(runner, repo, actual_digest, tuple(platforms))
        if children != platforms:
            raise ValueError('저장된 platform digest와 레지스트리가 다름')
        native = _command(runner, ['docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}']).strip()
        native = native.replace('/x86_64', '/amd64').replace('/aarch64', '/arm64')
        if native not in children:
            raise ValueError('이 Docker 호스트에서 실행할 platform이 없음')
        _command(runner, ['docker', 'pull', '--platform', native, image['reference']], 900)
        images = loads_strict(_command(runner, ['docker', 'image', 'inspect', image['reference']]))
        if not isinstance(images, list) or len(images) != 1:
            raise ValueError('이미지 조회 실패')
        local = images[0]
        expected_labels = {'org.opencontainers.image.revision': source['commit'],
                           'premortem.source_tree_sha256': source['tree_sha256'],
                           'premortem.run_id': build['run_id']}
        identity_kind = _verify_local_image(local, actual_digest, native, children[native], expected_labels)
        # 빌드한 PC와 실행하는 PC의 아키텍처가 달라도 같은 index를 쓴다.
        image.update(local_image_id=local['Id'], local_image_id_kind=identity_kind, platform=native)
        return build
    except (KeyError, TypeError, AttributeError, ValueError) as error:
        raise PremortemError('BUILD_IDENTITY_INVALID', str(error)) from error
