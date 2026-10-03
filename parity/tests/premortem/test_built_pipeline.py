"""실행·정책 사이에서 다른 이미지, 미완료 결과, 바뀐 소스가 섞이지 않는지 검사한다."""
import json
import shutil
import unittest
from pathlib import Path
from unittest.mock import patch

from premortem.built_image import verify_build
from premortem.built_test import test_build
from premortem.errors import PremortemError
from premortem.jsonio import load_json, write_json_atomic
from premortem.policy_preview import verify_test_bundle
from premortem.process import CommandResult
from premortem.snapshot import sha256_file
from tests.premortem import test_registry_build as registry_fixture
from tests.premortem.fakes import FakeDocker


class OwnedDocker(FakeDocker):
    def create(self, image_id, run_id, condition, port, sequence, host_port=None):
        self.fixed_port = host_port
        return super().create(image_id, run_id, condition, port, sequence)

    def _run(self, args, check=True):
        return CommandResult(tuple(args), 0, next(iter(self.containers)) + '\n', '')


class BuiltPipelineTest(unittest.TestCase):
    def setUp(self):
        self.fixture = registry_fixture.RegistryBuildTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.build = self.fixture.build()
        self.root = self.fixture.root
        self.manifest = self.fixture.out / 'build_manifest.json'
        self.record, self.noise = self.root / 'session.jsonl', self.root / 'noise.json'
        rows = [{'index': i, 'request': {'method': 'GET', 'path': '/health', 'headers': [],
                                       'body': '', 'body_encoding': 'utf8'},
                 'response': {'status': 200, 'headers': [], 'body': '{}', 'body_encoding': 'utf8'}}
                for i in (1, 2)]
        self.record.write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')
        write_json_atomic(self.noise, {'rules': []})
        self.out = self.root / 'test'
        self.docker = OwnedDocker()
        self.partial = False
        self.mutate_baseline = False

    def execute(self, args, log):
        raw = {'stage': 'test', 'commit': 'unknown', 'image': registry_fixture.CONFIG_ID, 'passed': False,
               'facts': [{'kind': 'sqlite', 'path': '/app/data.db', 'storage': 'container_layer', 'evidence': 'SQLite header'}],
               'replay': [{'condition': 'none', 'total': 2, 'matched': 2},
                          {'condition': 'restart', 'total': 2, 'matched': 2},
                          {'condition': 'replace', 'total': 2, 'matched': 1}],
               'mismatches': [{'condition': 'replace', 'index': 2, 'request': 'GET /health',
                               'expected': '200 {}', 'actual': '404 {}', 'related_fact': '/app/data.db'}]}
        if self.partial:
            raw['replay'][2]['error'] = 'REPLAY_INTERRUPTED'
        diagnostics = {'format': 'parity-execution-v1', 'status': 'error' if self.partial else 'completed',
                       'local_image_id': args.expected_image_id, 'registry_digest': None,
                       'baseline_unchanged': True, 'facts_collected': True,
                       'baseline_sha256': {'record': sha256_file(self.record), 'noise': sha256_file(self.noise)}}
        write_json_atomic(Path(args.out), raw)
        write_json_atomic(Path(args.out).with_name('result.diagnostics.json'), diagnostics)
        self.raw_bytes = Path(args.out).read_bytes()
        if self.mutate_baseline:
            self.record.write_text('changed', encoding='utf-8')
        return 2 if self.partial else 1

    def run_pipeline(self, **changes):
        kwargs = dict(manifest_path=self.manifest, record=self.record, noise=self.noise, app='sample',
                      out_dir=self.out, runner=self.fixture.runner, execute=self.execute, docker=self.docker)
        kwargs.update(changes)
        return test_build(**kwargs)

    def test_failed_app_completed_execution_preserves_raw_handoff_and_facts(self):
        summary = self.run_pipeline()
        self.assertEqual(summary['status'], 'completed')
        self.assertFalse(summary['passed'])
        self.assertEqual((self.out / 'result.json').read_bytes(), self.raw_bytes)
        handoff = load_json(self.out / 'parity_handoff.json')
        self.assertEqual(handoff['result'], json.loads(self.raw_bytes))
        self.assertEqual(handoff['metadata']['digest'], self.build['image']['registry_digest'])
        self.assertNotEqual(handoff['metadata']['digest'], registry_fixture.CONFIG_ID)
        self.assertTrue(1 <= self.docker.fixed_port <= 65535)
        self.assertEqual(verify_test_bundle(self.out), summary)

    def test_partial_execution_has_no_handoff(self):
        self.partial = True
        self.assertEqual(self.run_pipeline()['status'], 'error')
        self.assertFalse((self.out / 'parity_handoff.json').exists())
        with self.assertRaises(PremortemError):
            verify_test_bundle(self.out)

    def test_wrong_run_revision_digest_stop_before_container(self):
        for changes in ({'run_id': 'other'}, {'revision': 'b' * 40}, {'digest': 'sha256:' + 'c' * 64}):
            with self.subTest(changes=changes), self.assertRaises(PremortemError):
                self.run_pipeline(out_dir=self.root / ('out-' + next(iter(changes))), **changes)
        self.assertEqual(self.docker.calls, [])

    def test_tampered_build_source_stops_before_container(self):
        (self.manifest.parent / 'source/start.sh').write_text('changed', encoding='utf-8')
        with self.assertRaises(PremortemError):
            self.run_pipeline()
        self.assertEqual(self.docker.calls, [])

    def assert_source_changed(self):
        with self.assertRaises(PremortemError) as caught:
            self.run_pipeline()
        self.assertEqual(caught.exception.code, 'SOURCE_CHANGED')
        self.assertEqual(load_json(self.out / 'execution_error.json')['error_code'], 'SOURCE_CHANGED')
        for filename in ('parity_handoff.json', 'execution_manifest.json', 'verified.diagnostics.json'):
            self.assertFalse((self.out / filename).exists(), filename)

    def test_source_changed_after_pull_stops_before_container(self):
        run = self.fixture.runner.run

        def mutate_after_pull(args, timeout):
            result = run(args, timeout)
            if args[:2] == ['docker', 'pull']:
                (self.manifest.parent / 'source/start.sh').write_text('changed after pull', encoding='utf-8')
            return result

        with patch.object(self.fixture.runner, 'run', side_effect=mutate_after_pull):
            self.assert_source_changed()
        self.assertEqual(self.docker.calls, [])

    def test_copied_source_changed_stops_before_container(self):
        copytree = shutil.copytree

        def mutate_copy(source, destination, *args, **kwargs):
            result = copytree(source, destination, *args, **kwargs)
            (Path(destination) / 'start.sh').write_text('changed during copy', encoding='utf-8')
            return result

        with patch('premortem.built_test.shutil.copytree', side_effect=mutate_copy):
            self.assert_source_changed()
        self.assertEqual(self.docker.calls, [])

    def test_source_changed_during_replay_cleans_up_without_handoff(self):
        execute = self.execute

        def mutate_during_replay(args, log):
            code = execute(args, log)
            (self.out / 'source/start.sh').write_text('changed during replay', encoding='utf-8')
            return code

        with patch.object(self, 'execute', side_effect=mutate_during_replay), \
                patch.object(self.docker, 'cleanup', wraps=self.docker.cleanup) as cleanup:
            self.assert_source_changed()
        cleanup.assert_called_once()
        self.assertEqual((self.out / 'result.json').read_bytes(), self.raw_bytes)

    def test_excluded_file_added_during_replay_has_no_handoff(self):
        execute = self.execute

        def inject_during_replay(args, log):
            code = execute(args, log)
            (self.out / 'source/.env').write_text('injected=true', encoding='utf-8')
            return code

        with patch.object(self, 'execute', side_effect=inject_during_replay):
            self.assert_source_changed()

    def test_tampered_local_image_label_is_rejected(self):
        self.fixture.runner.bad_label = True
        with self.assertRaises(PremortemError):
            verify_build(self.manifest, self.fixture.runner)

    def test_registry_content_change_is_rejected(self):
        self.fixture.runner.raw[self.fixture.runner.index] += ' '
        with self.assertRaises(PremortemError):
            self.run_pipeline()
        self.assertEqual(self.docker.calls, [])

    def test_cleanup_failure_is_not_completed_or_handed_off(self):
        with patch.object(self.docker, 'cleanup', return_value=['not-removed']):
            with self.assertRaises(PremortemError) as caught:
                self.run_pipeline()
        self.assertEqual(caught.exception.code, 'CLEANUP_FAILED')
        self.assertFalse((self.out / 'parity_handoff.json').exists())
        self.assertFalse((self.out / 'execution_manifest.json').exists())

    def test_original_baseline_change_is_rejected(self):
        self.mutate_baseline = True
        with self.assertRaises(PremortemError):
            self.run_pipeline()
        self.assertFalse((self.out / 'parity_handoff.json').exists())

    def test_policy_rejects_modified_result_and_source(self):
        self.run_pipeline()
        original = (self.out / 'result.json').read_bytes()
        (self.out / 'result.json').write_bytes(original + b' ')
        with self.assertRaises(PremortemError):
            verify_test_bundle(self.out)
        (self.out / 'result.json').write_bytes(original)
        (self.out / 'source/start.sh').write_text('changed', encoding='utf-8')
        with self.assertRaises(PremortemError):
            verify_test_bundle(self.out)

    def test_output_cannot_overwrite_success(self):
        self.run_pipeline()
        original = (self.out / 'execution_manifest.json').read_bytes()
        with self.assertRaises(PremortemError) as caught:
            self.run_pipeline()
        self.assertEqual(caught.exception.code, 'RUN_EXISTS')
        self.assertEqual((self.out / 'execution_manifest.json').read_bytes(), original)
