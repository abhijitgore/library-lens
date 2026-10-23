"""Check the exact Git index before a public commit or push; print no secrets."""
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_FILES = {'.gitignore', '.gitattributes', '.env.example', 'README.md', 'PRIVACY.md', 'package.json', 'package-lock.json', 'LICENSE', 'LICENSE.md'}
# The public privacy policy is a copy of the private master; a public commit must not let them drift.
PRIVACY_MASTER = ROOT / 'ChromeExtensionStore' / 'privacy-policy.md'
PUBLIC_DIRS = {'extension': {'.json', '.html', '.css', '.js', '.png', '.svg'}, 'tests': {'.js', '.json', '.html', '.xml'}, 'scripts': {'.mjs', '.py'}, 'assets': {'.png', '.svg'}, '.github': {'.yml', '.yaml'}}
PRIVATE_DIRS = {'tasks', 'design', 'ChromeExtensionStore', 'releases', 'dist', 'node_modules', 'test-results', 'playwright-report', 'coverage', '.private', 'private', 'profiles'}
SECRET_NAMES = {'auth.json', '.npmrc', '.netrc', 'Cookies', 'Login Data', 'Local State', '.DS_Store'}
PATTERNS = {
    'private absolute path': re.compile(r'/(?:Users|home)/[^/\s]+/'),
    'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'GitHub token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b'),
    'AWS access key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'Slack token': re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{20,}\b'),
}
EMAIL = re.compile(r'\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b', re.I)


def check_index():
    result = subprocess.run(['git', 'ls-files', '--cached', '--stage', '-z'], cwd=ROOT, capture_output=True, check=True)
    entries = result.stdout.decode().split('\0')
    failures = []
    count = 0
    for entry in filter(None, entries):
        metadata, name = entry.split('\t', 1)
        if metadata.split()[0] == '120000':
            failures.append((name, 'symlinks are not public source files'))
            continue
        path = PurePosixPath(name)
        count += 1
        permitted = name in PUBLIC_FILES or path.suffix in PUBLIC_DIRS.get(path.parts[0], set()) or name == 'data/README.md'
        if not permitted or path.parts[0] in PRIVATE_DIRS:
            failures.append((name, 'file is outside the public allowlist'))
        if path.name in SECRET_NAMES or (path.name.startswith('.env') and path.name != '.env.example') or re.search(r'credentials|service.account', path.name, re.I) or path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.zip', '.gz'}:
            failures.append((name, 'private/generated filename'))
        # Read the staged content, not a potentially different working copy.
        data = subprocess.run(['git', 'show', ':' + name], cwd=ROOT, capture_output=True, check=True).stdout
        if b'\x00' in data:
            continue
        text = data.decode('utf-8', errors='replace')
        for label, pattern in PATTERNS.items():
            if pattern.search(text):
                failures.append((name, label))
        for match in EMAIL.finditer(text):
            domain = match[1].lower()
            if not (domain in {'example.com', 'example.org', 'example.net'} or domain.endswith(('.test', '.example', '.invalid'))):
                failures.append((name, 'non-example email address; review before publication'))
                break
    if PRIVACY_MASTER.is_file():
        staged = subprocess.run(['git', 'show', ':PRIVACY.md'], cwd=ROOT, capture_output=True)
        if staged.returncode != 0 or staged.stdout != PRIVACY_MASTER.read_bytes():
            failures.append(('PRIVACY.md', 'differs from ChromeExtensionStore/privacy-policy.md; copy the master before committing'))
    if not count:
        failures.append(('<index>', 'no staged or tracked public files to check'))
    if failures:
        for name, reason in failures:
            print(f'BLOCKED: {name}: {reason}', file=sys.stderr)
        return 1
    print(f'Public-file check passed for {count} indexed files. Run a secret scanner and manual security review too.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(check_index())
    except subprocess.CalledProcessError:
        sys.exit('Public-file check needs an initialized Git repository and readable index.')
