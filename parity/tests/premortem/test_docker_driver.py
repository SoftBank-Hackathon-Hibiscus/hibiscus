"""Docker 명령 구성과 자기 자원만 다루는 규칙 (ACCEPTANCE B12, B14, B15, B16). 실제 Docker 없이 실행한다."""

import json
import unittest

from premortem.config import OWNER_LABEL_KEY, OWNER_LABEL_VALUE, RUN_LABEL_KEY, Settings
from premortem.docker_driver import DockerDriver
from premortem.errors import PremortemError
from premortem.process import CommandResult

from tests.premortem.fakes import IMAGE_ID, FakeRunner

CONTAINER = "c" * 64


def ok(stdout=""):
    return CommandResult((), 0, stdout, "")


def inspect_json(labels, env=None):
    return json.dumps([{"Id": CONTAINER, "Image": IMAGE_ID, "State": {"Running": True, "StartedAt": "t", "ExitCode": 0},
                        "Config": {"Labels": labels, "Env": env or []}, "HostConfig": {"CapDrop": ["ALL"]}, "Mounts": []}])


class DockerDriverTest(unittest.TestCase):
    def test_b16_create_has_labels_loopback_publish_and_no_env_or_mounts(self):
        runner = FakeRunner(lambda args: ok(CONTAINER + "\n"))
        DockerDriver(runner, Settings()).create(IMAGE_ID, "run-1", "replace", 8000, 1)
        args = runner.calls[0]
        self.assertEqual(args[:2], ["docker", "create"])
        self.assertIn(f"{OWNER_LABEL_KEY}={OWNER_LABEL_VALUE}", args)
        self.assertIn(f"{RUN_LABEL_KEY}=run-1", args)
        self.assertIn("127.0.0.1::8000", args)
        self.assertIn("ALL", args[args.index("--cap-drop") + 1:])
        for forbidden in ("-e", "--env", "--env-file", "-v", "--volume", "--mount", "--privileged", "--network"):
            self.assertNotIn(forbidden, args)
        self.assertFalse(any("docker.sock" in a for a in args))
        self.assertEqual(args[-1], IMAGE_ID)

    def test_create_only_with_pinned_image_id(self):
        runner = FakeRunner(lambda args: ok(CONTAINER))
        with self.assertRaises(PremortemError):
            DockerDriver(runner, Settings()).create("my-app:latest", "run-1", "none", 8000, 1)
        self.assertEqual(runner.calls, [])

    def test_create_passes_only_explicit_test_environment(self):
        runner = FakeRunner(lambda args: ok(CONTAINER))
        DockerDriver(
            runner,
            Settings(),
            environment={'DATABASE_URL': 'postgres://test/database'},
        ).create(IMAGE_ID, 'run-1', 'health', 8080, 1)
        args = runner.calls[0]
        index = args.index('--env')
        self.assertEqual(args[index + 1], 'DATABASE_URL=postgres://test/database')
        self.assertEqual(args[-1], IMAGE_ID)

    def test_b14_foreign_container_is_not_removed(self):
        runner = FakeRunner(lambda args: ok(inspect_json({OWNER_LABEL_KEY: "someone-else", RUN_LABEL_KEY: "run-1"})))
        with self.assertRaises(PremortemError) as caught:
            DockerDriver(runner, Settings()).remove(CONTAINER, "run-1")
        self.assertEqual(caught.exception.code, "OWNERSHIP_MISMATCH")
        self.assertFalse(any(call[1] == "rm" for call in runner.calls))

    def test_b14_other_run_is_not_restarted(self):
        runner = FakeRunner(lambda args: ok(inspect_json({OWNER_LABEL_KEY: OWNER_LABEL_VALUE, RUN_LABEL_KEY: "run-2"})))
        with self.assertRaises(PremortemError):
            DockerDriver(runner, Settings()).restart(CONTAINER, "run-1")
        self.assertFalse(any(call[1] == "restart" for call in runner.calls))

    def test_b15_cleanup_reports_exact_ids_it_could_not_remove(self):
        mine_rm_fails, foreign, gone = "a" * 64, "b" * 64, "d" * 64

        def respond(args):
            if args[1:3] == ["container", "inspect"]:
                target = args[-1]
                if target == gone:
                    return CommandResult((), 1, "", "No such container")
                owner = OWNER_LABEL_VALUE if target == mine_rm_fails else "other"
                return ok(f"{owner}|run-1")
            if args[1] == "rm":
                return CommandResult((), 1, "", "device busy")
            return ok()

        runner = FakeRunner(respond)
        failures = DockerDriver(runner, Settings()).cleanup([mine_rm_fails, foreign, gone], "run-1")
        self.assertEqual(sorted(failures), sorted([mine_rm_fails, foreign]))
        removed = [call[-1] for call in runner.calls if call[1] == "rm"]
        self.assertEqual(removed, [mine_rm_fails])  # 다른 사람 컨테이너에는 rm을 부르지 않음

    def test_b12_daemon_unavailable(self):
        runner = FakeRunner(lambda args: CommandResult((), 1, "", "Cannot connect to the Docker daemon"))
        with self.assertRaises(PremortemError) as caught:
            DockerDriver(runner, Settings()).require_daemon()
        self.assertEqual(caught.exception.code, "DOCKER_UNAVAILABLE")
        self.assertEqual(caught.exception.exit_code, 2)

    def test_b13_timeout_becomes_unavailable_not_hang(self):
        def respond(args):
            raise PremortemError("TOOL_TIMEOUT", "docker version 시간 초과")
        with self.assertRaises(PremortemError) as caught:
            DockerDriver(FakeRunner(respond), Settings()).require_daemon()
        self.assertEqual(caught.exception.code, "DOCKER_UNAVAILABLE")

    def test_inspect_does_not_keep_env_values(self):
        runner = FakeRunner(lambda args: ok(inspect_json({}, env=["ANTHROPIC_API_KEY=test-only-not-a-key-123456"])))
        info = DockerDriver(runner, Settings()).inspect(CONTAINER)
        self.assertEqual(info["env_names"], ["ANTHROPIC_API_KEY"])
        self.assertNotIn("test-only-not-a-key", json.dumps(info))


if __name__ == "__main__":
    unittest.main()
