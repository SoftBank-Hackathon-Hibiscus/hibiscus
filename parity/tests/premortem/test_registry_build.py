"""빌드 → index → platform manifest → 로컬 config ID의 연결을 검사한다."""

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from premortem.errors import PremortemError
from premortem.process import CommandResult, SubprocessRunner
from premortem.registry_build import build_and_push

INDEX_TYPE = "application/vnd.oci.image.index.v1+json"
MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
CONFIG_ID = "sha256:" + "a" * 64


class RegistryRunner:
    def __init__(self):
        self.calls = []
        self.raw = {}
        self.labels = {}
        self.local_id = CONFIG_ID
        self.fail_push = False
        self.bad_label = False
        self.metadata_digest = None
        child = self.add_manifest({"schemaVersion": 2, "mediaType": MANIFEST_TYPE,
                                   "config": {"digest": CONFIG_ID}, "layers": []})
        self.child = child
        self.descriptors = [{"digest": child, "platform": {"os": "linux", "architecture": arch}}
                            for arch in ("amd64", "arm64")]
        self.set_index(self.descriptors)

    def add_manifest(self, obj):
        raw = json.dumps(obj)
        digest = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()
        self.raw[digest] = raw
        return digest

    def set_index(self, descriptors):
        self.index = self.add_manifest({"schemaVersion": 2, "mediaType": INDEX_TYPE, "manifests": descriptors})

    def run(self, args, timeout):
        self.calls.append(args)
        if args[0] == "git":
            return SubprocessRunner().run(args, timeout)
        output = ""
        if args[1] == "info":
            output = "linux/x86_64\n"
        elif args[1:3] == ["buildx", "build"]:
            self.labels = dict(args[i + 1].split("=", 1) for i, arg in enumerate(args) if arg == "--label")
            Path(args[args.index("--metadata-file") + 1]).write_text(
                json.dumps({"containerimage.digest": self.metadata_digest or self.index}), encoding="utf-8")
            if self.fail_push:
                return CommandResult(tuple(args), 1, "", "denied: registry push")
        elif args[1:4] == ["buildx", "imagetools", "inspect"]:
            output = self.raw[args[-1].split("@")[1]] + "\n"
        elif args[1:3] == ["image", "inspect"]:
            labels = dict(self.labels)
            if self.bad_label:
                labels["org.opencontainers.image.revision"] = "wrong"
            output = json.dumps([{"Id": self.local_id, "Os": "linux", "Architecture": "amd64",
                                  "Config": {"Labels": labels}}])
        elif args[1] != "pull":
            raise AssertionError(args)
        return CommandResult(tuple(args), 0, output, "")


class RegistryBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.app = self.repo / "app"
        self.app.mkdir(parents=True)
        (self.app / "Dockerfile").write_text("FROM scratch\nCOPY start.sh /start.sh\n", encoding="utf-8")
        (self.app / "start.sh").write_text("#!/bin/sh\necho hello\n", encoding="utf-8")
        (self.app / "start.sh").chmod(0o755)
        (self.app / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        self.git("init", "-q")
        self.git("add", ".")
        # Windows 파일 시스템에서도 커밋의 실행 여부를 명시한다.
        self.git("update-index", "--chmod=+x", "app/start.sh")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.runner = RegistryRunner()
        self.out = self.root / "build"

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True).stdout.strip()

    def build(self, **overrides):
        args = dict(app=self.app, image_repo="localhost:15000/app", out_dir=self.out,
                    runner=self.runner, run_id="check-1", builder="test-builder")
        args.update(overrides)
        return build_and_push(**args)

    def assert_failed(self, code):
        with self.assertRaises(PremortemError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, code)
        self.assertFalse((self.out / "build_manifest.json").exists())
        self.assertEqual(json.loads((self.out / "build_error.json").read_text())["error_code"], code)

    def test_committed_source_to_index_to_local_config(self):
        (self.app / "ignored.txt").write_text("must not enter the build", encoding="utf-8")
        result = self.build()
        image = result["image"]
        self.assertEqual(result["source"]["commit"], self.git("rev-parse", "HEAD"))
        self.assertEqual(result["source"]["subdir"], "app")
        self.assertFalse((self.out / "source" / "ignored.txt").exists())
        self.assertTrue(self.git("ls-tree", "HEAD", "app/start.sh").startswith("100755 "))
        self.assertEqual((self.out / "source" / "start.sh").read_bytes(),
                         (self.app / "start.sh").read_bytes())
        # Windows chmod/stat에는 POSIX 실행 비트가 없다.
        if os.name != "nt":
            self.assertTrue((self.out / "source" / "start.sh").stat().st_mode & 0o111)
            self.assertFalse((self.out / "source" / "Dockerfile").stat().st_mode & 0o111)
        self.assertEqual(image["registry_digest"], self.runner.index)
        self.assertEqual(image["local_image_id"], CONFIG_ID)
        self.assertNotEqual(image["registry_digest"], image["local_image_id"])
        self.assertTrue(image["registry_link_verified"])
        for args in self.runner.calls:
            if args[1:4] == ["buildx", "imagetools", "inspect"] or args[1] == "pull":
                self.assertIn("@sha256:", args[-1])
                self.assertNotIn(":build-", args[-1])
        self.assertEqual(json.loads((self.out / "build_manifest.json").read_text()), result)

    def test_attestation_descriptor_is_not_a_runtime_platform(self):
        self.runner.set_index(self.runner.descriptors + [{"digest": "sha256:" + "b" * 64,
            "platform": {"os": "unknown", "architecture": "unknown"},
            "annotations": {"vnd.docker.reference.type": "attestation-manifest"}}])
        self.assertEqual(set(self.build()["image"]["platforms"]), {"linux/amd64", "linux/arm64"})

    def test_source_changed_after_pull_is_not_success(self):
        run = self.runner.run

        def mutate_after_pull(args, timeout):
            result = run(args, timeout)
            if args[:2] == ["docker", "pull"]:
                (self.out / "source/start.sh").write_text("changed after pull", encoding="utf-8")
            return result

        with patch.object(self.runner, "run", side_effect=mutate_after_pull):
            self.assert_failed("SOURCE_CHANGED")

    def test_excluded_file_added_after_inspect_is_not_success(self):
        run = self.runner.run

        def mutate_after_inspect(args, timeout):
            result = run(args, timeout)
            if args[:3] == ["docker", "image", "inspect"]:
                (self.out / "source/.env").write_text("injected=true", encoding="utf-8")
            return result

        with patch.object(self.runner, "run", side_effect=mutate_after_inspect):
            self.assert_failed("SOURCE_CHANGED")

    def test_dirty_source_stops_before_docker(self):
        (self.app / "start.sh").write_text("changed", encoding="utf-8")
        self.assert_failed("SOURCE_DIRTY")
        self.assertFalse(any(args[0] == "docker" for args in self.runner.calls))

    def test_unrelated_repo_change_does_not_change_app_source(self):
        (self.repo / "unrelated.txt").write_text("outside app", encoding="utf-8")
        self.build()

    def test_failed_push_with_metadata_is_not_success(self):
        self.runner.fail_push = True
        self.assert_failed("BUILD_COMMAND_FAILED")
        self.assertFalse(any(args[1] == "pull" for args in self.runner.calls))

    def test_local_config_mismatch_is_not_success(self):
        self.runner.local_id = "sha256:" + "b" * 64
        self.assert_failed("BUILD_IDENTITY_INVALID")

    def test_revision_label_mismatch_is_not_success(self):
        self.runner.bad_label = True
        self.assert_failed("BUILD_IDENTITY_INVALID")

    def test_registry_content_digest_mismatch_is_not_success(self):
        self.runner.raw[self.runner.index] += " "
        self.assert_failed("BUILD_IDENTITY_INVALID")

    def test_single_manifest_cannot_be_reported_as_index(self):
        self.runner.metadata_digest = self.runner.child
        self.assert_failed("BUILD_IDENTITY_INVALID")

    def test_missing_platform_is_not_success(self):
        self.runner.set_index(self.runner.descriptors[:1])
        self.assert_failed("BUILD_IDENTITY_INVALID")

    def test_duplicate_platform_is_not_success(self):
        self.runner.set_index(self.runner.descriptors + self.runner.descriptors[:1])
        self.assert_failed("BUILD_IDENTITY_INVALID")

    def test_old_success_cannot_be_overwritten(self):
        self.build()
        original = (self.out / "build_manifest.json").read_bytes()
        self.runner.fail_push = True
        with self.assertRaises(PremortemError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "RUN_EXISTS")
        self.assertEqual((self.out / "build_manifest.json").read_bytes(), original)

    def test_bad_inputs_do_not_push(self):
        for override in ({"image_repo": "localhost:15000/app:tag"}, {"image_repo": "https://example.org/app"},
                         {"platforms": ("linux/amd64", "linux/amd64")}, {"platforms": ("windows/amd64",)},
                         {"out_dir": self.app / "output"}, {"timeout": 0}):
            with self.subTest(override=override), self.assertRaises(PremortemError):
                self.build(**override)
        self.assertEqual(self.runner.calls, [])


if __name__ == "__main__":
    unittest.main()
