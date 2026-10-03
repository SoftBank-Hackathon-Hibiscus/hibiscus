"""Backend에서 호출할 테스트 단계. 정책 변환까지만 하고 배포 파이프라인은 시작하지 않는다."""
import re
from pathlib import Path

from .built_test import test_build
from .errors import PremortemError
from .jsonio import load_json, write_json_atomic, write_text_atomic
from .paths import validate_run_id
from .policy_preview import call_policy, verify_test_bundle
from .process import SubprocessRunner
from .redact import redact


def validate_request(request):
    required = {'format', 'run_id', 'app', 'source_revision', 'digest', 'build_manifest', 'record', 'noise'}
    optional = {'port', 'health_path', 'health_timeout', 'after'}
    if (not isinstance(request, dict) or not required <= set(request) or set(request) - required - optional
            or request.get('format') != 'premortem-backend-test-v1'):
        raise PremortemError('INPUT_INVALID', 'Backend 테스트 요청 형식이 잘못됨')
    validate_run_id(request['run_id'])
    if (not isinstance(request['source_revision'], str) or not re.fullmatch(r'[0-9a-f]{40}', request['source_revision'])
            or not isinstance(request['digest'], str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', request['digest'])
            or not isinstance(request['app'], str) or not request['app'].strip()):
        raise PremortemError('INPUT_INVALID', '앱 이름·전체 커밋 SHA·index digest가 필요함')
    for name in ('build_manifest', 'record', 'noise'):
        if not isinstance(request[name], str) or not Path(request[name]).is_absolute():
            raise PremortemError('INPUT_INVALID', f'{name}은 실행 환경의 절대 경로여야 함')
    after = request.get('after', [])
    if not isinstance(after, list) or any(type(v) is not int or v < 1 for v in after):
        raise PremortemError('INPUT_INVALID', 'after는 양의 요청 번호 배열이어야 함')
    return request


def run_backend_test(request_path, out_dir, policy_root=None):
    request = validate_request(load_json(Path(request_path)))
    output = Path(out_dir).resolve()
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise PremortemError('RUN_EXISTS', 'Backend 결과 폴더는 새 폴더 또는 빈 폴더여야 함')
    output.mkdir(parents=True, exist_ok=True)
    policy = Path(policy_root or Path(__file__).resolve().parents[2] / 'policy').resolve()
    try:
        execution = test_build(manifest_path=request['build_manifest'], record=request['record'],
            noise=request['noise'], app=request['app'], out_dir=output / 'parity', runner=SubprocessRunner(),
            run_id=request['run_id'], revision=request['source_revision'], digest=request['digest'],
            port=request.get('port', 8080), health_path=request.get('health_path', '/healthz'),
            health_timeout=request.get('health_timeout', 30), after=tuple(request.get('after', [])))
        if execution['status'] != 'completed':
            raise PremortemError('TEST_INCOMPLETE', '시험이 중단되어 정책 입력을 만들지 않음')
        verify_test_bundle(output / 'parity')
        pending = output / 'test_result.pending.json'
        converted = call_policy(policy, ['src/adapters/cli.ts',
            '--handoff', str(output / 'parity/parity_handoff.json'),
            '--diagnostics', str(output / 'parity/verified.diagnostics.json'), '--out', str(pending)])
        write_text_atomic(output / 'adapter.log', redact(converted.stdout + converted.stderr))
        if converted.returncode != 0:
            raise PremortemError('POLICY_ADAPTER_FAILED', '정책 변환기가 원본 결과를 거부함. adapter.log 확인')
        normalized = load_json(pending)
        if (any(normalized.get(k) != request[k] for k in ('run_id', 'app', 'source_revision', 'digest'))
                or normalized.get('passed') is not execution['passed']):
            raise PremortemError('POLICY_CONTEXT_MISMATCH', '변환 결과의 식별값 또는 passed가 원본과 다름')
        verify_test_bundle(output / 'parity')
        write_json_atomic(output / 'test_result.json', normalized)
        pending.unlink()
        result = {'status': 'succeeded', 'exitCode': 0,
                  'artifacts': {'test_result': 'test_result.json', 'handoff': 'parity/parity_handoff.json',
                                'raw_result': 'parity/result.json', 'diagnostics': 'parity/verified.diagnostics.json'},
                  'summary': {'stub': False, 'test_passed': normalized['passed'],
                              **{k: request[k] for k in ('run_id', 'source_revision', 'digest')},
                              'policy_decided': False, 'deployment_executed': False}}
        write_json_atomic(output / 'stage_result.json', result)
        return result
    except (PremortemError, OSError, ValueError) as error:
        write_json_atomic(output / 'stage_result.json', {'status': 'failed', 'exitCode': 1, 'artifacts': {},
            'error': getattr(error, 'code', type(error).__name__)})
        raise
