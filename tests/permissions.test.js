import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('shipping manifest is click-only and permits only fixed supported library hosts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions.sort(), ['https://evgcatalog.kcls.org/*', 'https://kcls.bibliocommons.com/*', 'https://lx2.loc.gov/*', 'https://marinet.bibliocommons.com/*', 'https://oaklandlibrary.bibliocommons.com/*', 'https://orbiscascade-washington.primo.exlibrisgroup.com/*', 'https://seattle.bibliocommons.com/*', 'https://sfpl.bibliocommons.com/*', 'https://sjpl.bibliocommons.com/*', 'https://smcl.bibliocommons.com/*', 'https://www.spl.org/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.options_ui, { page: 'settings.html', open_in_tab: true });
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['icons/book-48.png'], matches: ['https://evgcatalog.kcls.org/*', 'https://www.spl.org/*'] }]);
  assert.equal(manifest.externally_connectable, undefined);
});
