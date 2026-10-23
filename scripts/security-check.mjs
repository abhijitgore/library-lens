// Check security boundaries without network traffic or real accounts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBookCandidates } from '../extension/lib/extract.js';
import { createLookupCoordinator } from '../extension/lib/lookups.js';
import { pendingBook } from '../extension/lib/pending.js';
import { lookupLibrary } from '../extension/lib/catalog.js';
import { pasteBookDetails } from '../extension/lib/paste.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const findings = {};
let now = 0;
const state = {};
const storage = {
  async get(key) { return { [key]: state[key] }; },
  async set(values) { Object.assign(state, values); },
  async remove(key) { delete state[key]; }
};
const lookup = createLookupCoordinator({ storage, now: () => now, lookup: async () => ({ count: 0 }) });
await lookup('kcls', { title: 'Synthetic privacy test' });
now = 600001;
assert.ok(state.latestLookup, 'Cache remains physically stored beyond validity period');
findings.cacheRetainedAfterTenMinutes = true;
state.pendingPurchaseBook = { id: 'synthetic', libraryId: 'kcls', book: { title: 'Synthetic' }, savedAt: Date.now() - 3600001 };
assert.ok(state.pendingPurchaseBook);
assert.equal(await pendingBook(storage), null);
findings.pendingExpiryIsLazy = !state.pendingPurchaseBook;

let bodyCancelled = false;
const oversizedBody = new ReadableStream({
  pull(controller) { controller.enqueue(new Uint8Array(4000000)); },
  cancel() { bodyCancelled = true; }
});
await assert.rejects(lookupLibrary('kcls', { title: 'Synthetic' }, { fetcher: async () => new Response(oversizedBody, { headers: { 'content-type': 'text/html' } }) }), /too large/);
assert.equal(bodyCancelled, true);
findings.oversizedBodyCancelledWhileReading = true;

const { chromium } = await import(process.env.LIBRARY_LENS_PLAYWRIGHT || 'playwright');
const profile = await mkdtemp(resolve(tmpdir(), 'library-lens-security-'));
const extension = resolve(root, 'extension');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  const requests = [];
  await context.route(/^https?:\/\//, async route => {
    const request = route.request();
    const headers = await request.allHeaders();
    requests.push({ url: request.url(), type: request.resourceType(), referrer: headers.referer || '', cookie: headers.cookie || '' });
    if (request.url() === 'https://source.example/book') {
      return route.fulfill({ contentType: 'text/html', body: '<script type="application/ld+json">{"@type":"Book","name":"Synthetic","image":"https://source.example/cover?token=synthetic"}</script>' });
    }
    if (request.url() === 'https://172.16.0.1/book') return route.fulfill({ contentType: 'text/html', body: '<main>Synthetic private page</main>' });
    return route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64') });
  });
  // A signed-in retailer session (SameSite=None cookies on the image host) must not ride along with cover requests.
  await context.addCookies([
    { name: 'session-id', value: 'synthetic-session', domain: 'm.media-amazon.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'source-session', value: 'synthetic-source', domain: 'source.example', path: '/', secure: true, sameSite: 'None' }
  ]);
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  const extensions = await manager.evaluate(() => new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, resolve)));
  const loaded = extensions.find(item => item.name === 'Library Lens — Public Libraries');
  assert.ok(loaded);
  const page = await context.newPage();
  await page.goto('https://source.example/book');
  const extracted = await page.evaluate(extractBookCandidates);
  // A cover on the source page's own origin is discarded; only the fixed retailer CDNs are accepted.
  assert.equal(extracted.candidates[0].coverUrl || '', '');
  findings.sameOriginCoverRejected = true;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${loaded.id}/popup.html`);
  const cdnCover = 'https://m.media-amazon.com/images/I/synthetic-cover.jpg';
  await popup.evaluate(async url => { const { renderCover } = await import('./lib/cover.js'); renderCover(url); }, cdnCover);
  await popup.waitForFunction(url => { const image = document.getElementById('book-cover'); return image.src === url && image.complete && !image.hidden; }, cdnCover);
  const coverRequest = requests.find(request => request.url === cdnCover && request.type === 'image');
  assert.ok(coverRequest);
  assert.equal(coverRequest.cookie, '');
  assert.equal(coverRequest.referrer, '');
  findings.coverRequestOmitsCookiesAndReferrer = true;
  // The popup CSP img-src stops hosts outside the allowlist before any request leaves the browser.
  await popup.evaluate(async url => { const { renderCover } = await import('./lib/cover.js'); renderCover(url); }, 'https://source.example/cover?token=synthetic');
  await popup.waitForTimeout(500);
  assert.equal(requests.some(request => request.url.startsWith('https://source.example/cover')), false);
  assert.equal(await popup.locator('#book-cover').isHidden(), true);
  findings.nonAllowlistedCoverBlockedByCsp = true;
  findings.coverRequests = requests.filter(request => request.type === 'image');
  // Hostile metadata stays literal through extraction, display, copy and form fill.
  const payload = '<img src=x onerror="globalThis.payloadExecuted=true">';
  const hostile = { '@type': 'Book', name: payload, author: { name: '<svg onload="globalThis.payloadExecuted=true">' }, isbn: '9780593135204', publisher: 'javascript:globalThis.payloadExecuted=true' };
  await page.setContent(`<script type="application/ld+json">${JSON.stringify(hostile).replaceAll('<', '\\u003c')}</script>`);
  const hostileBook = (await page.evaluate(extractBookCandidates)).candidates[0];
  assert.equal(hostileBook.title, payload);
  assert.equal(await page.evaluate(() => Boolean(globalThis.payloadExecuted)), false);
  // A prepared request does not bypass setup. Configure the synthetic user
  // before testing hostile metadata in the prepared-request UI.
  await popup.getByRole('heading', { name: 'Set up your libraries', exact: true }).waitFor();
  await popup.evaluate(async book => {
    await chrome.storage.local.set({ libraryPreferences: { selectedIds: ['spl'], preferredFormat: 'print' } });
    const { rememberBook } = await import('./lib/pending.js');
    await rememberBook('spl', book);
  }, hostileBook);
  await popup.reload();
  await popup.getByRole('heading', { name: 'Prepared for SPL' }).waitFor();
  assert.equal(await popup.locator('#pending-request p').first().textContent(), payload);
  assert.equal(await popup.locator('#pending-request img, #pending-request svg').count(), 0);
  await popup.evaluate(() => {
    // Capture the text-only API sink; do not overwrite the user's OS clipboard.
    navigator.clipboard.writeText = async value => { globalThis.copiedText = value; };
  });
  await popup.getByRole('button', { name: 'Copy book details', exact: true }).click();
  const copied = await popup.evaluate(() => globalThis.copiedText);
  assert.equal(typeof copied, 'string');
  assert.ok(copied.includes(payload));
  assert.equal(await popup.evaluate(() => Boolean(globalThis.payloadExecuted)), false);
  await context.route('https://www.spl.org/books-and-media/suggest-a-title', route => route.fulfill({ contentType: 'text/html', body: '<form id="s-la-askform-form_17516"><input id="pquestion_17516" name="pquestion"><input id="custom7_17516" name="custom7"><input id="custom2_17516" name="custom2"><textarea id="pdetails_17516" name="pdetails"></textarea><input id="card" value="untouched"><button>Submit</button></form>' }));
  await page.goto('https://www.spl.org/books-and-media/suggest-a-title');
  await page.evaluate(() => { globalThis.submissions = 0; document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); globalThis.submissions++; }); });
  const filled = await page.evaluate(([book, source]) => (0, eval)(`(${source})`)('spl', book), [hostileBook, pasteBookDetails.toString()]);
  assert.equal(filled.ok, true);
  assert.equal(await page.locator('#pquestion_17516').inputValue(), payload);
  assert.equal(await page.locator('form img, form svg, form script').count(), 0);
  assert.equal(await page.locator('#card').inputValue(), 'untouched');
  assert.equal(await page.evaluate(() => Boolean(globalThis.payloadExecuted)), false);
  assert.equal(await page.evaluate(() => globalThis.submissions), 0);
  findings.hostileMetadataRemainsLiteralText = true;
  findings.copyUsesTextOnlyApi = true;
  findings.hostileMetadataDoesNotExecuteOrSubmit = true;
  // Defense in depth: source gating is checked in the browser suite; the
  // extractor and display sink must also reject local/private image targets.
  await page.goto('https://172.16.0.1/book');
  await page.setContent('<script type="application/ld+json">{"@type":"Book","name":"Synthetic","image":"https://172.16.0.1/action"}</script>');
  assert.equal((await page.evaluate(extractBookCandidates)).candidates[0].coverUrl || '', '');
  for (const url of ['https://172.16.0.1/action', 'https://169.254.169.254/action', 'https://127.0.0.1/action', 'https://[::1]/action', 'https://localhost/action']) {
    await popup.evaluate(async url => { const { renderCover } = await import('./lib/cover.js'); renderCover(url); }, url);
    assert.equal(await popup.locator('#book-cover').getAttribute('src'), null);
    assert.equal(requests.some(request => request.url === url && request.type === 'image'), false);
  }
  findings.localCoverTargetsRejected = true;
  // No real private service or credential was contacted; all HTTP(S) is routed above.
} finally { await context.close(); }
await mkdir(resolve(root, 'test-results'), { recursive: true });
await writeFile(resolve(root, 'test-results/security-review.json'), JSON.stringify(findings, null, 2) + '\n');
console.log(JSON.stringify(findings, null, 2));
