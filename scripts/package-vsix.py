"""Build a VSIX containing the locked workbench runtime and offline bundle."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from zipfile import ZipFile


workspace = Path(__file__).resolve().parents[1]
extension = workspace / 'extension'
portal = workspace / 'portal'
offline = portal / 'connectors' / 'A800-Jupyter-Python312-offline.zip'
version = json.loads((extension / 'package.json').read_text(encoding='utf-8'))['version']
archive = workspace / 'downloads' / f'gpu-hzau-v{version}.vsix'
vsce = Path(sys.argv[1]).resolve(strict=True)
assert hashlib.sha256(offline.read_bytes()).hexdigest() == '1fdb947cfc45e4a401e2c54499d5f73551132701dabb799b9c3c4ff57cb7c1d5'

staging = (workspace / '.build').resolve()
staging.mkdir(exist_ok=True)
assert staging.is_relative_to(workspace)
with tempfile.TemporaryDirectory(prefix='build-vsix-', dir=staging) as temporary:
    package = Path(temporary)
    for source in extension.iterdir():
        if source.suffix == '.js' or source.name in ('package.json', '.vscodeignore', 'README.md'):
            shutil.copyfile(source, package / source.name)
    shutil.copytree(extension / 'media', package / 'media')
    backend = package / 'backend'
    for name in ('server', 'public'):
        shutil.copytree(portal / name, backend / name, ignore=shutil.ignore_patterns('__pycache__', '*.log'))
    connectors = backend / 'connectors'
    connectors.mkdir()
    for name in ('jupyter-bootstrap.py', 'tunnel-agent.py'):
        shutil.copyfile(portal / 'connectors' / name, connectors / name)
    shutil.copyfile(offline, connectors / offline.name)

    locked = json.loads((portal / 'package-lock.json').read_text(encoding='utf-8'))['packages']
    for name, entry in locked.items():
        if not name.startswith('node_modules/'):
            continue
        source = (portal / name).resolve(strict=True)
        assert source.is_relative_to(portal / 'node_modules')
        installed = json.loads((source / 'package.json').read_text(encoding='utf-8'))
        if installed['version'] != entry['version']:
            raise RuntimeError(f'{name} differs from the portal lockfile. Run npm ci in resource-portal.')
        shutil.copytree(source, backend / name, ignore=shutil.ignore_patterns('node_modules'), dirs_exist_ok=True)

    subprocess.run(['node', str(vsce), 'package', '--no-dependencies', '--allow-missing-repository', '--out', str(archive)],
                   cwd=package, check=True)

with ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    for name in ('server/index.mjs', 'node_modules/express/package.json', 'node_modules/playwright-core/browsers.json',
                 f'connectors/{offline.name}', 'public/index.html'):
        assert f'extension/backend/{name}' in bundle.namelist(), f'VSIX is missing {name}'

print(f'Built {archive.name} ({archive.stat().st_size:,} bytes)')
