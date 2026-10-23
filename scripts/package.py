"""Package only the inspected runtime, never tests, profiles, or session data."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text())
assert manifest['manifest_version'] == 3
assert set(manifest['permissions']) == {'activeTab', 'scripting', 'storage'}
assert set(manifest['host_permissions']) == {'https://kcls.bibliocommons.com/*', 'https://seattle.bibliocommons.com/*', 'https://sfpl.bibliocommons.com/*', 'https://oaklandlibrary.bibliocommons.com/*', 'https://marinet.bibliocommons.com/*', 'https://smcl.bibliocommons.com/*', 'https://sjpl.bibliocommons.com/*', 'https://orbiscascade-washington.primo.exlibrisgroup.com/*', 'https://www.spl.org/*', 'https://lx2.loc.gov/*', 'https://evgcatalog.kcls.org/*'}
assert manifest['background'] == {'service_worker': 'background.js', 'type': 'module'}
assert "img-src 'self' " in manifest['content_security_policy']['extension_pages'] and "connect-src 'self' " in manifest['content_security_policy']['extension_pages']
for key in ['content_scripts', 'optional_host_permissions', 'externally_connectable', 'web_accessible_resources']:
    assert key not in manifest, f'Unexpected permission/surface: {key}'
for path in [manifest['action']['default_popup'], manifest['background']['service_worker'], 'settings.html', *manifest['icons'].values()]:
    assert (extension / path).is_file(), f'Missing runtime file: {path}'
output = root / 'dist' / f'library-lens-{manifest["version"]}.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(extension.rglob('*')):
        if path.is_file() and not path.name.startswith('.'):
            assert path.suffix in {'.json', '.html', '.css', '.js', '.png', '.svg'}, f'Unexpected runtime file: {path}'
            archive.write(path, path.relative_to(extension))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert json.loads(archive.read('manifest.json')) == manifest
print(f'Packaged and verified {len(zipfile.ZipFile(output).namelist())} files: {output}')
