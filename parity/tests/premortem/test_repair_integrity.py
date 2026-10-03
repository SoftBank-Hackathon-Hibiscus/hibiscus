"""repair-build의 실제 결과 저장 경로. Docker·재생·AI 응답만 대체한다."""
import copy
import importlib
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from premortem.errors import PremortemError
from premortem.jsonio import load_json, write_json_atomic
from premortem.replay_port import ReplayOutcome, RequestResult
from premortem.snapshot import tree_hash, tree_listing
from tests.premortem.fakes import IMAGE_ID, FakeReplay, FakeRunner
from tests.premortem.test_parity_run import BuildingDocker, no_git

repair_build_module = importlib.import_module('premortem.repair_build')
runner_module = importlib.import_module('premortem.runner')


class RepairIntegrityTest(unittest.TestCase):
    def run_case(self, phase=None, mutation='source', cleanup_failure=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        source = self.root / 'build/source'
        source.mkdir(parents=True)
        (source / 'app.py').write_text('HOST = "127.0.0.1"\n', encoding='utf-8')
        (source / 'Dockerfile').write_text('FROM scratch\n', encoding='utf-8')
        original = tree_listing(source)
        manifest = source.parent / 'build_manifest.json'
        write_json_atomic(manifest, {'run_id': 'integrity-pre'})
        session, noise = self.root / 'session.jsonl', self.root / 'noise.json'
        session.write_text(''.join(json.dumps({'index': i}) + '\n' for i in range(1, 7)), encoding='utf-8')
        write_json_atomic(noise, {'rules': []})
        self.output = self.root / 'repair'
        analysis = {
            'provider': 'supplied_json', 'model': None, 'status': 'succeeded', 'error_code': None,
            'usage': {}, 'output': {'manual_actions': [],
                'edits': [{'path': 'app.py', 'before': '"127.0.0.1"', 'after': '"0.0.0.0"'}],
                'findings': [{'category': 'binding', 'confidence': 1.0,
                    'evidence_ids': ['synthetic'], 'source_locations': [{'path': 'app.py'}],
                    'observed_fact': 'synthetic', 'root_cause_hypothesis': 'synthetic'}]},
        }

        def mutate(context):
            if mutation == 'source':
                (context / 'app.py').write_text('changed\n', encoding='utf-8')
            elif mutation == 'excluded':
                (context / '.env').write_text('TEST_ONLY=true\n', encoding='utf-8')
            elif mutation == 'directory':
                (context / 'node_modules').mkdir(exist_ok=True)
            elif mutation == 'symlink':
                (context / 'link.py').symlink_to(context / 'app.py')
            elif mutation == 'deleted':
                (context / 'app.py').unlink()

        class Docker(BuildingDocker):
            context = None
            cleanup_called = False

            def build(self, context, tag, labels):
                self.context = Path(context)
                result = super().build(context, tag, labels)
                if phase == 'build':
                    mutate(self.context)
                return result

            def cleanup(self, container_ids, run_id):
                if self.context is not None:
                    self.cleanup_called = True
                    if phase == 'cleanup':
                        mutate(self.context)
                    if cleanup_failure:
                        return ['synthetic-container']
                return super().cleanup(container_ids, run_id)

        class Replay(FakeReplay):
            backend = 'parity'
            mutated = False

            def replay(self, session_path, noise_path, target_for_request, after_response, runtime_secrets):
                if self.docker.context is None:
                    return super().replay(session_path, noise_path, target_for_request, after_response, runtime_secrets)
                if phase == 'replay' and not self.mutated:
                    mutate(self.docker.context)
                    self.mutated = True
                result = ReplayOutcome('parity', 6, 0, 0, [])
                for index in range(1, 7):
                    target_for_request(index)
                    result.results.append(RequestResult(index, True, None, 'synthetic match'))
                    result.executed_count += 1
                    result.matched_count += 1
                    if index < 6:
                        after_response(index)
                return result

        self.docker = Docker()
        verified = {'source': {'tree_sha256': tree_hash(original[0]), 'commit': 'a' * 40},
                    'image': {'reference': 'example.invalid/app@sha256:' + 'b' * 64,
                              'local_image_id': IMAGE_ID, 'registry_digest': 'sha256:' + 'b' * 64,
                              'registry_link_verified': True, 'source_build_link_verified': True,
                              'platform': 'linux/amd64'}}
        condition_runner = runner_module.ConditionRunner

        def ready(*args, **kwargs):
            return condition_runner(*args, http_check=lambda url: True, sleep=lambda secs: None, **kwargs)

        with ExitStack() as stack:
            stack.enter_context(patch.object(repair_build_module, 'SubprocessRunner', return_value=FakeRunner(no_git)))
            stack.enter_context(patch.object(repair_build_module, 'DockerDriver', return_value=self.docker))
            stack.enter_context(patch.object(repair_build_module, 'load_parity_adapter', return_value=Replay(self.docker)))
            stack.enter_context(patch('premortem.built_image.verify_build', return_value=verified))
            stack.enter_context(patch.object(runner_module, 'ConditionRunner', side_effect=ready))
            stack.enter_context(patch('premortem.repair.analyze_run', return_value=(copy.deepcopy(analysis), {}, 'synthetic')))
            try:
                return repair_build_module.repair_build(
                    manifest_path=manifest, record=session, noise=noise, name='integrity', out_dir=self.output,
                    allowed=('app.py',), ai_mode='json-file', analysis_file=self.root / 'analysis.json', after=(3,))
            finally:
                self.assertEqual(tree_listing(source), original)

    def assert_rejected(self, phase, mutation):
        with self.assertRaises(PremortemError) as caught:
            self.run_case(phase, mutation)
        self.assertEqual(caught.exception.code, 'SOURCE_CHANGED')
        self.assertFalse((self.output / 'repair_summary.json').exists())
        self.assertEqual(list(self.output.rglob('handoff_bundle.json')), [])
        self.assertFalse((self.docker.context.parent / 'env_report.json').exists())
        self.assertEqual(self.docker.containers, {})
        if phase == 'build':
            self.assertFalse(self.docker.cleanup_called)  # 재검사 컨테이너를 만들기 전에 거부
        else:
            self.assertTrue(self.docker.cleanup_called)

    def test_changes_during_build_are_rejected_before_replay(self):
        for mutation in ('source', 'excluded', 'directory', 'symlink', 'deleted'):
            with self.subTest(mutation=mutation):
                self.assert_rejected('build', mutation)

    def test_changes_during_replay_are_rejected_after_cleanup(self):
        for mutation in ('source', 'excluded'):
            with self.subTest(mutation=mutation):
                self.assert_rejected('replay', mutation)

    def test_changes_during_cleanup_are_rejected(self):
        self.assert_rejected('cleanup', 'source')

    def test_retest_cleanup_failure_has_no_success_bundle(self):
        with self.assertRaises(PremortemError) as caught:
            self.run_case(cleanup_failure=True)
        self.assertEqual(caught.exception.code, 'CLEANUP_FAILED')
        self.assertFalse((self.output / 'repair_summary.json').exists())
        self.assertEqual(list(self.output.rglob('handoff_bundle.json')), [])

    def test_unchanged_retest_retains_review_and_source_identity(self):
        result = self.run_case()
        self.assertTrue(result['expected_outcome'])
        self.assertEqual(result['review_status'], 'awaiting_human_review')
        self.assertFalse(result['original_applied'])
        self.assertFalse(result['deployment_executed'])
        retest = Path(result['retest']['run_dir'])
        self.assertTrue((self.output / 'repair_summary.json').exists())
        self.assertTrue((retest / 'handoff_bundle.json').exists())
        report = load_json(retest / 'env_report.json')
        self.assertEqual(report['overall_status'], 'passed')
        files, excludes = tree_listing(retest / 'source')
        self.assertEqual(tree_hash(files), report['source']['tree_sha256'])
        self.assertEqual(excludes, [])
