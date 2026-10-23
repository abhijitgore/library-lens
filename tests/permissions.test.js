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
  // Nothing is web-accessible: library pages cannot probe for the install. The helper icon is inlined.
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /^script-src 'self'; object-src 'none'; base-uri 'none'; /);
  assert.match(csp, /img-src 'self' https:\/\/m\.media-amazon\.com https:\/\/images-na\.ssl-images-amazon\.com https:\/\/images-eu\.ssl-images-amazon\.com https:\/\/cdn\.shopify\.com;/);
  assert.match(csp, /connect-src 'self' https:\/\/kcls\.bibliocommons\.com /);
});
