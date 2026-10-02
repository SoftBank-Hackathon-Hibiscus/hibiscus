import copy
import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

from parity import docker_ops


# 기존 컨테이너가 실제로 사용하던 이미지 ID
IMAGE_ID = "sha256:" + "a" * 64

CONTAINER_INFO = {
    "Image": IMAGE_ID,
    "Config": {
        "Image": "guestbook:1",
        "Env": ["PORT=8080"],
        "Cmd": ["python", "app.py"],
    },
    "HostConfig": {
        "PortBindings": {
            "8080/tcp": [
                {"HostIp": "127.0.0.1", "HostPort": "8080"}
            ]
        }
    },
}

IMAGE_INFO = json.dumps([
    {
        "Config": {
            "Env": ["PORT=8080"],
            "Cmd": ["python", "app.py"],
        }
    }
])


class RecreateTest(unittest.TestCase):
    def recreate_with_fake_docker(self):
        # 실제 Docker 대신, 어떤 명령을 호출했는지만 기록한다.
        with patch.object(
            docker_ops, "inspect", return_value=CONTAINER_INFO
        ), patch.object(
            docker_ops, "docker", return_value=IMAGE_INFO
        ) as fake_docker:
            docker_ops.recreate("guestbook-test")

        return fake_docker

    def test_uses_original_image_id(self):
        fake_docker = self.recreate_with_fake_docker()

        # 이미지 설정 조회에도 고유 ID를 사용해야 한다.
        fake_docker.assert_any_call(
            "image", "inspect", IMAGE_ID
        )

        # 새 컨테이너 실행에도 같은 ID를 사용해야 한다.
        run_args = fake_docker.call_args_list[-1].args
        self.assertEqual(run_args[-1], IMAGE_ID)

    def test_preserves_name_and_fixed_port(self):
        fake_docker = self.recreate_with_fake_docker()

        self.assertEqual(
            fake_docker.call_args_list[-2:],
            [
                call("rm", "-f", "guestbook-test"),
                call(
                    "run", "-d",
                    "--name", "guestbook-test",
                    "-p", "127.0.0.1:8080:8080/tcp",
                    IMAGE_ID,
                ),
            ],
        )


class RecreateContractTest(unittest.TestCase):
    def call_recreate(self, info, image_info=IMAGE_INFO, identifier="guestbook-test"):
        with patch.object(docker_ops, "inspect", return_value=info), patch.object(
                docker_ops, "docker", return_value=image_info) as fake:
            docker_ops.recreate(identifier)
        return fake

    def assert_rejected_before_delete(self, info, image_info=IMAGE_INFO):
        with patch.object(docker_ops, "inspect", return_value=info), patch.object(
                docker_ops, "docker", return_value=image_info) as fake:
            with self.assertRaises(docker_ops.DockerError):
                docker_ops.recreate("guestbook-test")
        self.assertFalse(any(c.args[0] in ("rm", "run") for c in fake.call_args_list))

    def test_empty_zero_invalid_or_unpublished_ports_do_not_delete(self):
        for value in ("", "0", "65536", "abc", "8080-8081", None, 8080):
            info = copy.deepcopy(CONTAINER_INFO)
            info["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostPort"] = value
            with self.subTest(port=value):
                self.assert_rejected_before_delete(info)
        for ports in ({}, None, {"8080/tcp": []}, {"8080/tcp": None},
                      {"0/tcp": [{"HostPort": "8080"}]}, {"8080/udp": [{"HostPort": "8080"}]}):
            info = copy.deepcopy(CONTAINER_INFO)
            info["HostConfig"]["PortBindings"] = ports
            with self.subTest(bindings=ports):
                self.assert_rejected_before_delete(info)

    def test_custom_mount_network_and_privilege_are_rejected_before_delete(self):
        changes = [("Mounts", [{"Type": "bind", "Source": "/x", "Target": "/app"}]),
                   ("NetworkMode", "host"), ("NetworkMode", "team-network"),
                   ("Privileged", True), ("CapAdd", ["SYS_ADMIN"]),
                   ("PublishAllPorts", True), ("Devices", [{"PathOnHost": "/dev/x"}])]
        for key, value in changes:
            info = copy.deepcopy(CONTAINER_INFO)
            info["HostConfig"][key] = value
            with self.subTest(option=key, value=value):
                self.assert_rejected_before_delete(info)

    def test_unrepresented_resolved_mount_or_network_alias_is_rejected(self):
        info = copy.deepcopy(CONTAINER_INFO)
        info["Mounts"] = [{"Type": "volume", "Destination": "/data", "Name": "anonymous"}]
        self.assert_rejected_before_delete(info)
        info = copy.deepcopy(CONTAINER_INFO)
        info["NetworkSettings"] = {"Networks": {"bridge": {"Aliases": ["special-name"]}}}
        self.assert_rejected_before_delete(info)
        info["NetworkSettings"] = {"Networks": {"private-net": {}}}
        self.assert_rejected_before_delete(info)

    def test_preserves_peer_labels_and_basic_safety_resources(self):
        info = copy.deepcopy(CONTAINER_INFO)
        info["Config"]["Labels"] = {"premortem.owner": "juyeong", "premortem.run_id": "run-1"}
        info["HostConfig"].update(NetworkMode="bridge", CapDrop=["ALL"],
                                 SecurityOpt=["no-new-privileges"], Memory=268435456,
                                 MemorySwap=536870912, PidsLimit=128, NanoCpus=1_500_000_000,
                                 ReadonlyRootfs=True, Init=True)
        args = self.call_recreate(info).call_args_list[-1].args
        for flag, value in (("--label", "premortem.owner=juyeong"), ("--label", "premortem.run_id=run-1"),
                            ("--cap-drop", "ALL"), ("--security-opt", "no-new-privileges"),
                            ("--memory", "268435456"), ("--memory-swap", "536870912"),
                            ("--pids-limit", "128"), ("--cpus", "1.5")):
            with self.subTest(flag=flag, value=value):
                self.assertIn((flag, value), list(zip(args, args[1:])))
        self.assertIn("--read-only", args)
        self.assertIn("--init", args)
        self.assertEqual(args[-1], IMAGE_ID)

    def test_preserves_user_workdir_entrypoint_and_command(self):
        info = copy.deepcopy(CONTAINER_INFO)
        info["Config"].update(User="1000:1000", WorkingDir="/workspace",
                              Entrypoint=["python", "-u"], Cmd=["service.py"])
        args = self.call_recreate(info).call_args_list[-1].args
        for flag, value in (("--user", "1000:1000"), ("--workdir", "/workspace"), ("--entrypoint", "python")):
            self.assertIn((flag, value), list(zip(args, args[1:])))
        self.assertEqual(args[-3:], (IMAGE_ID, "-u", "service.py"))

    def test_preserves_explicit_bind_and_tmpfs(self):
        info = copy.deepcopy(CONTAINER_INFO)
        info["HostConfig"].update(Binds=["guestbook-data:/data:rw"], Tmpfs={"/cache": "size=16m"})
        info["Mounts"] = [{"Type": "volume", "Destination": "/data"},
                           {"Type": "tmpfs", "Destination": "/cache"}]
        args = self.call_recreate(info).call_args_list[-1].args
        self.assertIn(("-v", "guestbook-data:/data:rw"), list(zip(args, args[1:])))
        self.assertIn(("--tmpfs", "/cache:size=16m"), list(zip(args, args[1:])))

    def test_container_id_input_keeps_inspected_name_and_ipv6_port(self):
        info = copy.deepcopy(CONTAINER_INFO)
        info["Name"] = "/guestbook-test"
        info["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostIp"] = "::1"
        fake = self.call_recreate(info, identifier="a" * 64)
        args = fake.call_args_list[-1].args
        self.assertIn(("--name", "guestbook-test"), list(zip(args, args[1:])))
        self.assertIn(("-p", "[::1]:8080:8080/tcp"), list(zip(args, args[1:])))
        fake.assert_any_call("rm", "-f", "a" * 64)

    def test_invalid_image_id_or_unrestorable_default_command_does_not_delete(self):
        info = copy.deepcopy(CONTAINER_INFO)
        info["Image"] = "guestbook:latest"
        self.assert_rejected_before_delete(info)
        info = copy.deepcopy(CONTAINER_INFO)
        info["Config"]["Cmd"] = []
        self.assert_rejected_before_delete(info)

    def test_image_id_helper_never_returns_tag(self):
        with patch.object(docker_ops, "inspect", return_value=CONTAINER_INFO):
            self.assertEqual(docker_ops.image_id_of("guestbook-test"), IMAGE_ID)
        with patch.object(docker_ops, "inspect", return_value={"Image": "guestbook:1"}):
            with self.assertRaises(docker_ops.DockerError):
                docker_ops.image_id_of("guestbook-test")


class DockerCommandErrorTest(unittest.TestCase):
    def test_timeout_is_docker_error_without_command_secrets(self):
        with patch.object(docker_ops.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                ["docker", "run", "-e", "TOKEN=secret-value"], 1)):
            with self.assertRaises(docker_ops.DockerError) as caught:
                docker_ops.docker("run", "-e", "TOKEN=secret-value", timeout=1)
        self.assertNotIn("secret-value", str(caught.exception))

    def test_nonzero_exit_does_not_export_arguments_or_stderr(self):
        result = SimpleNamespace(returncode=1, stdout="", stderr="TOKEN=secret-value")
        with patch.object(docker_ops.subprocess, "run", return_value=result):
            with self.assertRaises(docker_ops.DockerError) as caught:
                docker_ops.docker("run", "-e", "TOKEN=secret-value")
        self.assertNotIn("secret-value", str(caught.exception))
        self.assertIn("exit 1", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
