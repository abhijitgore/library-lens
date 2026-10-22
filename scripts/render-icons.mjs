import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'assets/library-lens-master.png');
for (const size of [16, 32, 48, 128]) {
  execFileSync('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', resolve(root, `extension/icons/book-${size}.png`)], { stdio: 'ignore' });
}
console.log('Rendered the transparent master logo at 16, 32, 48 and 128 pixels with macOS sips.');
