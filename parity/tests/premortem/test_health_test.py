import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from premortem.health_test import test_build_health


class HealthBuildTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = self.root / 'build' / 'build_manifest.json'
        (self.manifest.parent / 'source').mkdir(parents=True)
        (self.manifest.parent / 'source' / 'Dockerfile').write_text('FROM scratch\n', encoding='utf-8')
        self.manifest.write_text('{}', encoding='utf-8')
        self.output = self.root / 'output'
        self.output.mkdir()
        self.digest = 'sha256:' + 'a' * 64
        self.revision = 'b' * 40
        self.build = {
            'run_id': 'run-1',
            'source': {'commit': self.revision, 'tree_sha256': 'tree'},
            'image': {'registry_digest': self.digest, 'local_image_id': 'sha256:' + 'c' * 64},
        }

    def test_passes_after_the_verified_candidate_becomes_healthy(self):
        docker = self.docker()
        with patch('premortem.health_test.verify_build', return_value=self.build), \
                patch('premortem.health_test.verify_source_tree'), \
                patch('premortem.health_test.DockerDriver', return_value=docker), \
                patch('premortem.health_test.http_ok', side_effect=[False, True]), \
                patch('premortem.health_test.time.sleep'):
            result = self.run_health()

        self.assertTrue(result['passed'])
        self.assertEqual(result['match'], {'total': 1, 'matched': 1})
        self.assertEqual(result['failures'], [])
        docker.cleanup.assert_called_once_with(['container-1'], 'run-1')
        self.assertTrue((self.output / 'parity/source/Dockerfile').is_file())
        self.assertTrue((self.output / 'parity/build_manifest.json').is_file())

    def test_returns_a_failed_test_result_when_the_container_stops(self):
        docker = self.docker()
        docker.inspect.side_effect = [
            {'image': self.build['image']['local_image_id'], 'running': True},
            {'image': self.build['image']['local_image_id'], 'running': False},
        ]
        with patch('premortem.health_test.verify_build', return_value=self.build), \
                patch('premortem.health_test.verify_source_tree'), \
                patch('premortem.health_test.DockerDriver', return_value=docker), \
                patch('premortem.health_test.http_ok', return_value=False), \
                patch('premortem.health_test.time.sleep'):
            result = self.run_health()

        self.assertFalse(result['passed'])
        self.assertEqual(result['match'], {'total': 1, 'matched': 0})
        self.assertEqual(result['failures'][0]['request'], 'GET /healthz')

    def test_passes_test_environment_to_the_docker_driver(self):
        docker = self.docker()
        with patch('premortem.health_test.verify_build', return_value=self.build), \
                patch('premortem.health_test.verify_source_tree'), \
                patch('premortem.health_test.DockerDriver', return_value=docker) as driver, \
                patch('premortem.health_test.http_ok', return_value=True):
            test_build_health(
                manifest_path=self.manifest,
                run_id='run-1',
                revision=self.revision,
                digest=self.digest,
                port=8080,
                health_path='/healthz',
                health_timeout=1,
                environment={'DATABASE_URL': 'postgres://test/database'},
                out_dir=self.output,
            )
        driver.assert_called_once()
        self.assertEqual(driver.call_args.kwargs['environment'], {'DATABASE_URL': 'postgres://test/database'})

    def docker(self):
        docker = MagicMock()
        docker.create.return_value = 'container-1'
        docker.inspect.return_value = {
            'image': self.build['image']['local_image_id'],
            'running': True,
        }
        docker.host_port.return_value = 49152
        docker.cleanup.return_value = []
        return docker

    def run_health(self):
        return test_build_health(
            manifest_path=self.manifest,
            run_id='run-1',
            revision=self.revision,
            digest=self.digest,
            port=8080,
            health_path='/healthz',
            health_timeout=1,
            out_dir=self.output,
        )


if __name__ == '__main__':
    unittest.main()
