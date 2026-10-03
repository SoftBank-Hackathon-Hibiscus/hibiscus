"""Run the built image and verify only its configured health endpoint."""

import shutil
import time
from pathlib import Path

from .built_image import verify_build
from .config import Settings
from .docker_driver import DockerDriver
from .errors import PremortemError
from .lifecycle import http_ok
from .process import SubprocessRunner
from .snapshot import verify_source_tree


def test_build_health(*, manifest_path, run_id, revision, digest, port,
                      health_path, health_timeout, environment=None, out_dir):
    manifest_path = Path(manifest_path).resolve()
    output = Path(out_dir).resolve()
    if (not isinstance(health_path, str) or not health_path.startswith('/')
            or any(character.isspace() for character in health_path)
            or type(port) is not int or not 1 <= port <= 65535
            or type(health_timeout) not in (int, float) or health_timeout <= 0):
        raise PremortemError('INPUT_INVALID', 'Health check settings are invalid')

    runner = SubprocessRunner()
    build = verify_build(
        manifest_path,
        runner,
        run_id=run_id,
        revision=revision,
        digest=digest,
    )
    parity_output = output / 'parity'
    parity_output.mkdir(parents=True, exist_ok=False)
    shutil.copytree(manifest_path.parent / 'source', parity_output / 'source')
    shutil.copy2(manifest_path, parity_output / 'build_manifest.json')
    verify_source_tree(parity_output / 'source', build['source']['tree_sha256'])

    driver = DockerDriver(runner, Settings(), environment=environment)
    local_image_id = build['image']['local_image_id']
    container = driver.create(local_image_id, run_id, 'health', port, 1)
    passed = False
    failures = []
    try:
        driver.start(container)
        info = driver.inspect(container)
        if info['image'] != local_image_id:
            raise PremortemError(
                'IMAGE_IDENTITY_MISMATCH',
                'Health check container does not use the verified image',
            )
        target = f"http://127.0.0.1:{driver.host_port(container, port)}{health_path}"
        deadline = time.monotonic() + health_timeout
        while time.monotonic() < deadline:
            if http_ok(target):
                passed = True
                break
            if not driver.inspect(container)['running']:
                break
            time.sleep(0.25)
        if not passed:
            failures.append(
                {
                    'request': f'GET {health_path}',
                    'reason': 'Candidate health check failed',
                }
            )
    finally:
        cleanup_failures = driver.cleanup([container], run_id)
    if cleanup_failures:
        raise PremortemError(
            'CLEANUP_FAILED',
            'Health check container cleanup failed',
        )
    verify_source_tree(parity_output / 'source', build['source']['tree_sha256'])
    return {
        'run_id': run_id,
        'app': None,
        'source_revision': revision,
        'digest': digest,
        'passed': passed,
        'match': {'total': 1, 'matched': 1 if passed else 0},
        'failures': failures,
        'facts': {
            'health': {
                'path': health_path,
                'passed': passed,
            }
        },
    }
