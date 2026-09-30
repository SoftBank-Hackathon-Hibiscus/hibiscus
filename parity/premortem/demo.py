"""개발용 샘플 시연(state-loss, binding). 실제 팀 앱이 아니다.

state-loss: none·restart는 데이터가 남고 replace는 사라지는지 실제 Docker로 확인한다.
binding: 컨테이너 밖에서 접속이 안 되는 것을 확인하고, AI 수정 → 복사본 재빌드 → 같은 기록으로 재검증한다.
"""

from pathlib import Path
from typing import Optional

from .adapters.reference_replay import ReferenceReplayPort
from .config import Settings
from .docker_driver import DockerDriver
from .handoff import write_handoff
from .process import SubprocessRunner
from .report import summary_lines, write_report
from .runner import execute_run
from .scenarios import get_scenario


def run_demo(scenario_name: str, ai_mode: str, settings: Settings, analysis_file: Optional[Path] = None,
             run_root: Optional[Path] = None, plan_path: Optional[Path] = None) -> dict:
    scenario = get_scenario(scenario_name)
    command_runner = SubprocessRunner()
    docker = DockerDriver(command_runner, settings)
    docker.require_daemon()
    replay = ReferenceReplayPort(settings.request_timeout_sec, settings.max_body_bytes, settings.max_requests)

    pre = execute_run(scenario, scenario.app_dir, "pretest", None, settings, docker, replay, command_runner, run_root)
    write_report(pre.run_dir)
    write_handoff(pre.run_dir)
    statuses = {c["name"]: c["status"] for c in pre.env_report["conditions"]}
    result = {
        "scenario": scenario_name,
        "pretest": {"run_id": pre.run_id, "run_dir": str(pre.run_dir), "overall_status": pre.env_report["overall_status"],
                    "conditions": statuses, "summary": summary_lines(pre.env_report)},
        "expected_pretest": scenario.expected_pretest,
        "pretest_matches_design": statuses == scenario.expected_pretest,
        "cleanup_failures": list(pre.cleanup_failures),
    }
    if scenario_name == "binding" and ai_mode != "off":
        from .repair import run_repair_loop  # M2

        result["repair"] = run_repair_loop(scenario, pre, ai_mode, settings, docker, replay, command_runner,
                                           analysis_file, run_root, plan_path)
        result["cleanup_failures"] += result["repair"].get("cleanup_failures", [])
    return result
