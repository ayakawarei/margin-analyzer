"""Manual main-only release; retry safely using the existing SHA image/manifest."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def api(path):
    request = urllib.request.Request(
        'https://api.github.com/' + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def image_digest(image):
    result = subprocess.run(
        ['docker', 'buildx', 'imagetools', 'inspect', image],
        text=True, capture_output=True)
    if result.returncode:
        # Authentication, connectivity and other errors must never mean absent.
        if re.search(r'(?i)(manifest unknown|:\s*not found\b)', result.stderr) and not re.search(
                r'(?i)(unauthorized|denied|forbidden)', result.stderr):
            return None
        raise RuntimeError(result.stderr)
    match = re.search(r'^Digest:\s+(sha256:[0-9a-f]{64})$', result.stdout, re.M)
    if not match:
        raise RuntimeError('Registry response did not contain an image digest')
    return match.group(1)


def smoke(image):
    name = 'margin-release-smoke'
    run('docker', 'run', '-d', '--name', name,
        '-p', '127.0.0.1:8849:8848', image)
    try:
        for attempt in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8849/api/health', timeout=3) as response:
                    assert json.load(response)['ok'] is True
                break
            except (OSError, AssertionError):
                if attempt == 29:
                    raise
                time.sleep(1)
        with urllib.request.urlopen('http://127.0.0.1:8849/', timeout=5) as response:
            assert '<html' in response.read().decode().lower()
        assert run('docker', 'image', 'inspect', image,
                   '--format', '{{.Os}}/{{.Architecture}}') == 'linux/amd64'
    finally:
        subprocess.run(['docker', 'logs', name], check=False)
        run('docker', 'rm', '-f', name)


def main():
    if os.environ['RELEASE_REF'] != 'refs/heads/main':
        raise RuntimeError('Only main can publish a production release')
    commit = os.environ['RELEASE_COMMIT']
    assert re.fullmatch('[0-9a-f]{40}', commit)
    assert run('git', 'rev-parse', 'HEAD') == commit
    repo = os.environ['RELEASE_REPOSITORY']
    image = 'ghcr.io/' + repo.lower()
    sha_image = image + ':' + commit
    tag = 'release-' + commit
    release = api(f'repos/{repo}/releases/tags/{tag}')
    ref = api(f'repos/{repo}/git/ref/tags/{tag}')
    if ref and (ref['object']['type'] != 'commit' or ref['object']['sha'] != commit):
        raise RuntimeError('Existing release tag does not point to this commit')
    digest = image_digest(sha_image)
    if release and (not digest or release['draft'] or release['prerelease']):
        raise RuntimeError('Existing release/image is inconsistent; manual review required')
    if digest:
        # Never overwrite a SHA tag: dependencies/base images can change on retry.
        run('docker', 'pull', '--platform', 'linux/amd64', image + '@' + digest)
        smoke(image + '@' + digest)
    else:
        run('docker', 'buildx', 'build', '--platform', 'linux/amd64', '--load',
            '--label', 'org.opencontainers.image.source=https://github.com/' + repo,
            '--label', 'org.opencontainers.image.revision=' + commit,
            '-t', sha_image, '.')
        smoke(sha_image)
        run('docker', 'push', sha_image)
        digest = image_digest(sha_image)
        if not digest:
            raise RuntimeError('Pushed image digest could not be verified')
    manifest = {'image': image + '@' + digest, 'commit': commit, 'platform': 'linux/amd64'}
    Path('production.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if release:
        assets = [a for a in release['assets'] if a['name'] == 'production.json']
        if len(assets) != 1:
            raise RuntimeError('Existing release must have exactly one production.json')
        with tempfile.TemporaryDirectory() as directory:
            run('gh', 'release', 'download', tag, '--repo', repo,
                '--pattern', 'production.json', '--dir', directory)
            if json.loads(Path(directory, 'production.json').read_text()) != manifest:
                raise RuntimeError('Existing release manifest differs; refusing to overwrite')
        print('Release already published with matching manifest:', release['html_url'])
    else:
        # gh creates a formal Release and uploads the asset in one command.
        # If upload fails after creation, fail safely; do not overwrite on retry.
        print(run('gh', 'release', 'create', tag, 'production.json', '--repo', repo,
                  '--target', commit, '--title', 'Production ' + commit,
                  '--notes', 'linux/amd64 image: `' + manifest['image'] + '`',
                  '--latest=false'))


if __name__ == '__main__':
    main()
