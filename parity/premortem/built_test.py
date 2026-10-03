"""검증된 빌드 이미지를 윤선님의 test 실행기에 넘긴다. 원본 결과는 그대로 보존한다."""
import contextlib
import math
import shutil
import socket
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

from .built_image import verify_build
from .config import Settings
from .docker_driver import DockerDriver
from .errors import PremortemError
from .gate import fault_positions
from .jsonio import load_json, write_json_atomic
from .snapshot import copy_file, sha256_file, verify_source_tree


def test_build(*, manifest_path, record, noise, app, out_dir, runner, run_id=None,
               revision=None, digest=None, port=8080, health_path='/healthz', health_timeout=30,
               after=(), execute=None, docker=None):
    from parity.execution import Baseline, run_test
    from parity.handoff import write_handoff

    record, noise, out_dir = Path(record).resolve(), Path(noise).resolve(), Path(out_dir).resolve()
    manifest_path = Path(manifest_path).resolve()
    if (not isinstance(app, str) or not app.strip() or type(port) is not int or not 1 <= port <= 65535
            or type(health_timeout) not in (int, float) or not math.isfinite(health_timeout) or health_timeout <= 0
            or not isinstance(health_path, str) or not health_path.startswith('/')
            or any(c.isspace() for c in health_path)):
        raise PremortemError('INPUT_INVALID', '앱 이름·포트·health 경로·제한 시간을 확인해 주세요')
    if not record.is_file() or not noise.is_file():
        raise PremortemError('INPUT_INVALID', '기록과 노이즈 파일이 모두 필요함')
    if manifest_path.parent == out_dir or manifest_path.parent in out_dir.parents:
        raise PremortemError('INPUT_INVALID', '빌드 결과 밖에 새 테스트 폴더를 지정해 주세요')
    try:
        out_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise PremortemError('RUN_EXISTS', '기존 테스트 결과는 덮어쓰지 않음') from None
    try:
        build = verify_build(manifest_path, runner, run_id=run_id, revision=revision, digest=digest)
        baseline = Baseline(record, noise)
        if len(baseline.records) > Settings().max_requests:
            raise PremortemError('INPUT_INVALID', '기록 요청 수가 실행 상한을 넘음')
        positions = fault_positions(list(after), len(baseline.records))
        if not positions:
            raise PremortemError('INPUT_INVALID', '세 조건을 시험하려면 요청이 두 건 이상 필요함')
        run_id = build['run_id']
        local_id = build['image']['local_image_id']
        shutil.copytree(manifest_path.parent / 'source', out_dir / 'source', symlinks=True)
        verify_source_tree(out_dir / 'source', build['source']['tree_sha256'])
        copy_file(record, out_dir / 'baseline/session.jsonl', sha256_file(record))
        copy_file(noise, out_dir / 'baseline/noise.json', sha256_file(noise))
        write_json_atomic(out_dir / 'build_manifest.json', build)
        driver = docker or DockerDriver(runner, Settings())
        condition = 'parity-' + uuid.uuid4().hex[:8]
        name = f'premortem-{run_id}-{condition}-1'
        # parity의 recreate는 같은 호스트 포트를 유지한다. 충돌하면 Docker가 생성 전에 거부한다.
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            host_port = reservation.getsockname()[1]
        container = driver.create(local_id, run_id, condition, port, 1, host_port=host_port)
        cleanup_failures = []
        try:
            driver.start(container)
            target = f'http://127.0.0.1:{driver.host_port(container, port)}'
            args = SimpleNamespace(out=str(out_dir / 'result.json'), record=str(out_dir / 'baseline/session.jsonl'),
                noise=str(out_dir / 'baseline/noise.json'), conditions='none,restart,replace', container=name,
                target=target, health_path=health_path, health_timeout=health_timeout,
                restart_after=','.join(map(str, positions)), restart_every=False, cafile=None, header=[],
                expected_image_id=local_id)
            # parity의 사람이 읽는 요약이 --json stdout에 섞이지 않게 한다.
            with contextlib.redirect_stdout(sys.stderr):
                code = (execute or run_test)(args, log=lambda msg: print(msg, file=sys.stderr))
        finally:
            # parity가 교체한 새 컨테이너도 같은 이름과 소유 라벨을 갖는다.
            found = driver._run(['container', 'inspect', '--format', '{{.Id}}', name], check=False)
            if found.returncode == 0:
                cleanup_failures = driver.cleanup([found.stdout.strip()], run_id)
            else:
                cleanup_failures = driver.cleanup([container], run_id)
        result = load_json(out_dir / 'result.json')
        diagnostics = load_json(out_dir / 'result.diagnostics.json')
        baseline.check()
        if cleanup_failures:
            raise PremortemError('CLEANUP_FAILED', '이 실행이 만든 컨테이너를 정리하지 못함')
        completed = code in (0, 1) and diagnostics['status'] == 'completed'
        if (diagnostics['local_image_id'] != local_id or diagnostics['baseline_unchanged'] is not True
                or diagnostics['baseline_sha256'] != baseline.hashes()):
            raise PremortemError('BUILD_IDENTITY_INVALID', '실제 시험 이미지나 기준 파일이 입력과 다름')
        # 재생 도중 복사본이 바뀌었으면 완료 진단과 정책 인계 파일을 내보내지 않는다.
        verify_source_tree(out_dir / 'source', build['source']['tree_sha256'])
        verified = dict(diagnostics, registry_digest=build['image']['registry_digest'],
                        source_revision=build['source']['commit'], run_id=run_id,
                        target_binding_verified=True, result_sha256=sha256_file(out_dir / 'result.json'))
        write_json_atomic(out_dir / 'verified.diagnostics.json', verified)
        if completed:
            write_handoff(out_dir / 'result.json', out_dir / 'parity_handoff.json', run_id=run_id, app=app,
                          source_revision=build['source']['commit'], digest=build['image']['registry_digest'])
        artifacts = {p.name: sha256_file(p) for p in out_dir.iterdir() if p.is_file()}
        summary = {'format': 'premortem-test-build-v1', 'run_id': run_id, 'app': app,
                   'source_revision': build['source']['commit'], 'digest': build['image']['registry_digest'],
                   'local_image_id': local_id, 'status': 'completed' if completed else 'error',
                   'passed': result['passed'], 'parity_exit_code': code, 'artifacts': artifacts,
                   'settings': {'port': port, 'health_path': health_path, 'health_timeout': health_timeout,
                                'after': positions}, 'cleanup_failures': cleanup_failures}
        write_json_atomic(out_dir / 'execution_manifest.json', summary)
        return summary
    except (PremortemError, ValueError, OSError) as error:
        wrapped = error if isinstance(error, PremortemError) else PremortemError('TEST_BUILD_FAILED', str(error))
        write_json_atomic(out_dir / 'execution_error.json', {'error_code': wrapped.code, 'message': wrapped.message})
        raise wrapped from error
