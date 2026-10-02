"""빌드된 앱을 분석하고 수정 복사본을 같은 기록으로 재검증한다. 원본 반영 기능은 없다."""
import math
import re
from pathlib import Path

from .adapters.parity_adapter import load_parity_adapter
from .config import CORE_CONDITIONS, Settings
from .docker_driver import DockerDriver
from .errors import PremortemError
from .jsonio import load_json, write_json_atomic
from .patch.guard import check_path
from .paths import resolve_inside, validate_run_id
from .process import SubprocessRunner
from .repair import run_repair_loop
from .report import write_report
from .runner import execute_run
from .scenarios import Scenario


def repair_build(*, manifest_path, record, noise, name, out_dir, allowed, ai_mode,
                 analysis_file=None, plan=None, port=8080, health_path='/healthz', health_timeout=30, after=()):
    manifest_path, output = Path(manifest_path).resolve(), Path(out_dir).resolve()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,39}', name):
        raise PremortemError('INPUT_INVALID', '앱 이름은 소문자·숫자·-_. 40자 이내여야 함')
    if ai_mode not in ('live', 'json-file', 'recorded') or ((ai_mode != 'live') != bool(analysis_file)):
        raise PremortemError('INPUT_INVALID', 'json-file·recorded에는 analysis-file이 필요하며 live에는 쓰지 않음')
    if not allowed or not math.isfinite(health_timeout) or health_timeout <= 0 or not 1 <= port <= 65535:
        raise PremortemError('INPUT_INVALID', '수정할 앱 파일과 올바른 포트·health timeout이 필요함')
    if output == manifest_path.parent or manifest_path.parent in output.parents:
        raise PremortemError('INPUT_INVALID', '빌드 결과 밖에 새 수정 검토 폴더를 지정해 주세요')
    build = load_json(manifest_path)
    run_id = validate_run_id(build['run_id'])
    source = manifest_path.parent / 'source'
    for rel in allowed:
        check_path(rel, allowed)
        if not resolve_inside(source, rel).is_file():
            raise PremortemError('INPUT_INVALID', '허용한 앱 소스 파일을 찾을 수 없음')
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise PremortemError('RUN_EXISTS', '기존 수정 검토 결과는 덮어쓰지 않음') from None
    scenario = Scenario(name, '빌드 이미지 수정 검토', source, Path(record).resolve(), Path(noise).resolve(),
                        port, health_path, health_timeout, tuple(after), CORE_CONDITIONS, tuple(allowed), {})
    settings, runner = Settings(), SubprocessRunner()
    docker = DockerDriver(runner, settings)
    replay = load_parity_adapter()
    pre = execute_run(scenario, source, 'pretest', None, settings, docker, replay, runner,
                      output / 'runs', run_id=run_id, build_manifest=manifest_path)
    write_report(pre.run_dir)
    if pre.cleanup_failures:
        raise PremortemError('CLEANUP_FAILED', '검사 컨테이너 정리에 실패해 수정 단계를 중단함')
    result = run_repair_loop(scenario, pre, ai_mode, settings, docker, replay, runner,
        Path(analysis_file) if analysis_file else None, output / 'runs', Path(plan) if plan else None)
    result.update(pretest_dir=str(pre.run_dir), original_applied=False, deployment_executed=False)
    write_json_atomic(output / 'repair_summary.json', result)
    return result
