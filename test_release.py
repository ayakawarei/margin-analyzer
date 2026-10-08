"""Offline checks for release ordering, retries and safety guards."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import publish_release as release

SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64
IMAGE = 'ghcr.io/ayakawarei/margin-analyzer'


class ReleaseTests(unittest.TestCase):
    def test_registry_errors_are_not_absence(self):
        for error in ('unauthorized: authentication required', 'dial tcp: lookup host: no such host',
                      '403 Forbidden', 'TLS certificate verification failed'):
            with self.subTest(error=error), patch.object(release.subprocess, 'run', return_value=
                    subprocess.CompletedProcess([], 1, '', error)):
                with self.assertRaises(RuntimeError):
                    release.image_digest(IMAGE)

    def test_missing_manifest(self):
        with patch.object(release.subprocess, 'run', return_value=
                subprocess.CompletedProcess([], 1, '', 'ERROR: manifest unknown')):
            self.assertIsNone(release.image_digest(IMAGE))

    def test_digest_format(self):
        with patch.object(release.subprocess, 'run', return_value=
                subprocess.CompletedProcess([], 0, 'Digest: ' + DIGEST, '')):
            self.assertEqual(release.image_digest(IMAGE), DIGEST)

    def exercise(self, digest, existing=None, fail_smoke=False):
        events = []
        manifest = {'image': IMAGE + '@' + DIGEST, 'commit': SHA, 'platform': 'linux/amd64'}

        def command(*args):
            events.append(args)
            if args[:2] == ('git', 'rev-parse'):
                return SHA
            if args[:3] == ('gh', 'release', 'download'):
                Path(args[-1], 'production.json').write_text(json.dumps(manifest))
            return 'ok'

        def smoke(image):
            events.append(('smoke', image))
            if fail_smoke:
                raise RuntimeError('smoke failed')

        env = {'RELEASE_REF': 'refs/heads/main', 'RELEASE_COMMIT': SHA,
               'RELEASE_REPOSITORY': 'ayakawarei/margin-analyzer'}
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(release.os.environ, env), \
             patch.object(release, 'api', side_effect=[existing, None]), \
             patch.object(release, 'image_digest', side_effect=[digest, DIGEST]), \
             patch.object(release, 'run', side_effect=command), \
             patch.object(release, 'smoke', side_effect=smoke), \
             patch.object(release, 'Path', side_effect=lambda *args: Path(directory, *args)):
            if fail_smoke:
                with self.assertRaises(RuntimeError):
                    release.main()
            else:
                release.main()
                self.assertEqual(json.loads(Path(directory, 'production.json').read_text()), manifest)
        return events

    def test_smoke_before_push_before_release(self):
        events = self.exercise(None)
        kinds = [e[:2] for e in events]
        smoke_index = next(i for i, e in enumerate(events) if e[0] == 'smoke')
        self.assertLess(smoke_index, kinds.index(('docker', 'push')))
        self.assertLess(kinds.index(('docker', 'push')), kinds.index(('gh', 'release')))

    def test_smoke_failure_prevents_publication(self):
        events = self.exercise(None, fail_smoke=True)
        self.assertFalse(any(e[:2] == ('docker', 'push') or e[:2] == ('gh', 'release') for e in events))

    def test_existing_image_is_not_rebuilt_or_overwritten(self):
        events = self.exercise(DIGEST)
        self.assertFalse(any(e[:2] in [('docker', 'buildx'), ('docker', 'push')] for e in events))

    def test_existing_matching_release_is_not_recreated(self):
        events = self.exercise(DIGEST, {'draft': False, 'prerelease': False,
                                      'assets': [{'name': 'production.json'}], 'html_url': 'existing'})
        self.assertFalse(any(e[:3] == ('gh', 'release', 'create') for e in events))

    def test_non_main_is_rejected(self):
        with patch.dict(release.os.environ, {'RELEASE_REF': 'refs/heads/feature'}):
            with self.assertRaises(RuntimeError):
                release.main()

    def test_incomplete_release_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'exactly one production.json'):
            self.exercise(DIGEST, {'draft': False, 'prerelease': False, 'assets': []})

    def test_draft_release_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'inconsistent'):
            self.exercise(DIGEST, {'draft': True, 'prerelease': False})

    def test_wrong_existing_tag_is_rejected(self):
        env = {'RELEASE_REF': 'refs/heads/main', 'RELEASE_COMMIT': SHA,
               'RELEASE_REPOSITORY': 'ayakawarei/margin-analyzer'}
        with patch.dict(release.os.environ, env), \
             patch.object(release, 'run', return_value=SHA), \
             patch.object(release, 'api', side_effect=[None, {'object': {
                 'type': 'commit', 'sha': 'c' * 40}}]), \
             patch.object(release, 'image_digest') as registry:
            with self.assertRaisesRegex(RuntimeError, 'does not point'):
                release.main()
            registry.assert_not_called()


if __name__ == '__main__':
    unittest.main()
