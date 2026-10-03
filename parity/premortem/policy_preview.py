"""보존한 parity 원본을 정책 담당자의 변환기/실행기에 넘긴다. 서명·배포는 호출하지 않는다."""
import os
import subprocess
from pathlib import Path

from .errors import PremortemError
from .jsonio import load_json, write_json_atomic, write_text_atomic
from .process import _ENV_PASSTHROUGH
from .redact import redact
from .snapshot import sha256_file, tree_hash, tree_listing


def verify_test_bundle(test_dir):
    from parity.handoff import build_envelope

    root = Path(test_dir).resolve()
    try:
        execution = load_json(root / 'execution_manifest.json')
        if execution['format'] != 'premortem-test-build-v1' or execution['status'] != 'completed':
            raise ValueError('세 조건 시험이 완료되지 않음')
        for name in ('result.json', 'result.diagnostics.json', 'verified.diagnostics.json',
                     'parity_handoff.json', 'build_manifest.json'):
            if sha256_file(root / name) != execution['artifacts'][name]:
                raise ValueError(f'시험 산출물이 바뀜: {name}')
        build = load_json(root / 'build_manifest.json')
        handoff = load_json(root / 'parity_handoff.json')
        diagnostics = load_json(root / 'verified.diagnostics.json')
        metadata = {key: execution[key] for key in ('run_id', 'app', 'source_revision', 'digest')}
        if handoff != build_envelope((root / 'result.json').read_bytes(), 'result.json', metadata):
            raise ValueError('인계 묶음과 원본 결과가 다름')
        if (build['run_id'] != metadata['run_id'] or build['source']['commit'] != metadata['source_revision']
                or build['image']['registry_digest'] != metadata['digest']
                or diagnostics['registry_digest'] != metadata['digest']
                or diagnostics['status'] != 'completed' or diagnostics['facts_collected'] is not True
                or diagnostics['local_image_id'] != build['image']['local_image_id']
                or diagnostics['local_image_id'] != execution['local_image_id']
                or diagnostics['result_sha256'] != sha256_file(root / 'result.json')):
            raise ValueError('실행·빌드·진단의 식별값 또는 facts 수집 상태가 다름')
        for key, name in (('record', 'session.jsonl'), ('noise', 'noise.json')):
            if sha256_file(root / 'baseline' / name) != diagnostics['baseline_sha256'][key]:
                raise ValueError('테스트 기준 파일이 바뀜')
        files, excludes = tree_listing(root / 'source')
        if excludes or tree_hash(files) != build['source']['tree_sha256']:
            raise ValueError('정책에 넘길 소스가 빌드한 소스와 다름')
        return execution
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise PremortemError('TEST_ARTIFACT_MISMATCH', str(error)) from error


def call_policy(policy_root, args, timeout=120):
    root = Path(policy_root).resolve()
    cli = root / 'node_modules/tsx/dist/cli.mjs'
    if not cli.is_file():
        raise PremortemError('POLICY_ADAPTER_MISSING', '정책 폴더에서 npm ci를 먼저 실행해 주세요')
    env = {key: os.environ[key] for key in _ENV_PASSTHROUGH if key in os.environ}
    try:
        result = subprocess.run(['node', str(cli), *args], cwd=root, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=timeout,
                                stdin=subprocess.DEVNULL, shell=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PremortemError('POLICY_EXECUTION_FAILED', type(error).__name__) from error
    return result


def preview_policy(test_dir, out_dir, policy_root=None):
    root, output = Path(test_dir).resolve(), Path(out_dir).resolve()
    policy = Path(policy_root or Path(__file__).resolve().parents[2] / 'policy').resolve()
    execution = verify_test_bundle(root)
    if root == output or root in output.parents:
        raise PremortemError('INPUT_INVALID', '테스트 결과 밖에 새 정책 결과 폴더를 지정해 주세요')
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise PremortemError('RUN_EXISTS', '기존 정책 결과는 덮어쓰지 않음') from None
    result = call_policy(policy, ['src/stage.ts', '--src', str(root / 'source'),
        '--handoff', str(root / 'parity_handoff.json'), '--diagnostics', str(root / 'verified.diagnostics.json'),
        '--policy', str(policy / 'policy.yaml'), '--out-dir', str(output), '--log', str(output / 'decisions.jsonl'),
        '--source-revision', execution['source_revision'], '--classifier', 'heuristic', '--json', '--explain'])
    write_text_atomic(output / 'stdout.log', redact(result.stdout))
    write_text_atomic(output / 'stderr.log', redact(result.stderr))
    if result.returncode not in (0, 2, 3):
        raise PremortemError('POLICY_EXECUTION_FAILED', f'정책 실행 종료 코드 {result.returncode}. stderr.log 확인')
    verify_test_bundle(root)
    plan = load_json(output / 'plan.json')
    decision = {0: 'allow', 2: 'needs_approval', 3: 'block'}[result.returncode]
    if (any(plan.get(k) != execution[k] for k in ('run_id', 'app', 'digest', 'source_revision'))
            or plan.get('decision') != decision):
        raise PremortemError('POLICY_CONTEXT_MISMATCH', '정책 결정서가 이번 시험과 다름')
    summary = {'status': 'completed', 'decision': decision, 'exit_code': result.returncode,
               'run_id': execution['run_id'], 'digest': execution['digest'],
               'source_revision': execution['source_revision'], 'targets': plan['targets'],
               'requires': plan.get('requires', []), 'plan_path': str(output / 'plan.json'),
               'classifier': 'heuristic', 'deployment_executed': False}
    write_json_atomic(output / 'preview.json', summary)
    return summary
