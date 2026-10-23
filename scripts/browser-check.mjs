import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBookCandidates } from '../extension/lib/extract.js';
import { pasteBookDetails } from '../extension/lib/paste.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.LIBRARY_LENS_PLAYWRIGHT || 'playwright');
const profile = await mkdtemp(resolve(tmpdir(), 'library-lens-test-'));
const extension = resolve(root, 'extension');
const results = resolve(root, 'test-results');
await mkdir(results, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 1000, height: 1000 }
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push({ url: page.url(), message: error.message })));
// The request helper lives in a closed shadow root, which page scripts and
// Playwright locators cannot reach. Read and drive it through CDP instead.
async function withHelper(page, action) {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#library-lens-request-helper' });
    if (!nodeId) return action(null);
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: -1, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return action(null);
    const nodes = [];
    (function walk(n) { nodes.push(n); for (const child of n.children || []) walk(child); })(shadow);
    const attr = (n, name) => { const index = (n.attributes || []).indexOf(name); return index >= 0 ? n.attributes[index + 1] : null; };
    const helper = {
      mode: shadow.shadowRootType,
      text: nodes.filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ').replace(/\s+/g, ' ').trim(),
      button: label => nodes.find(n => n.nodeName === 'BUTTON' && attr(n, 'aria-label') === label),
      img: nodes.find(n => n.nodeName === 'IMG'),
      status: nodes.find(n => attr(n, 'role') === 'status'),
      async evaluate(n, functionDeclaration) {
        const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendNodeId });
        const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, returnByValue: true });
        return result.value;
      },
      async click(n) {
        // A real pointer click, so the helper's isTrusted check passes.
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
        const [x1, y1, , , x2, y2] = model.content;
        await page.mouse.click((x1 + x2) / 2, (y1 + y2) / 2);
      }
    };
    return await action(helper);
  } finally { await cdp.detach().catch(() => {}); }
}
async function waitForHelper(page, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await withHelper(page, helper => helper ? predicate(helper) : false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Request helper condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
try {
  await context.route(/^https?:\/\//, route => route.abort());
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  const extensions = await manager.evaluate(() => new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve)));
  const loaded = extensions.find(item => item.name === 'Library Lens — Public Libraries');
  assert.ok(loaded, 'Shipping extension loads in Chromium');
  assert.equal(loaded.state, 'ENABLED');
  assert.equal(loaded.manifestErrors?.length || 0, 0);
  console.log('PASS: shipping manifest and service worker load');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const installationSettings = context.pages().find(page => page.url() === `chrome-extension://${loaded.id}/settings.html`);
  assert.ok(installationSettings, 'First install opens ZIP and library setup');
  assert.equal(await installationSettings.locator('#preferred-format').inputValue(), 'print');
  await installationSettings.close();
  console.log('PASS: fresh installation opens setup for ZIP and library selection');
  const fixtures = Object.fromEntries(await Promise.all(['kcls', 'spl', 'sfpl', 'oakland', 'marin', 'smcl'].map(async name => [name, await readFile(resolve(root, `tests/fixtures/${name}.html`), 'utf8')])));
  fixtures.uw = await readFile(resolve(root, 'tests/fixtures/uw.json'), 'utf8');
  // Include misleading translations/editions to verify they never reach confirmed rows.
  const catalogJson = fixtures.kcls.match(/data-iso-key="_0">([\s\S]*?)<\/script>/)[1];
  const mixedCatalog = JSON.parse(catalogJson);
  const baseBib = mixedCatalog.entities.bibs.S82C2114334;
  for (const [id, format] of [['S82C9999991', 'BK'], ['S82C9999992', 'EBOOK']]) {
    mixedCatalog.entities.bibs[id] = structuredClone(baseBib);
    Object.assign(mixedCatalog.entities.bibs[id].briefInfo, { title: 'Gong zuo zhe de AI gong zhi mo shi', authors: ['Weir, Andy'], isbns: [], format, primaryLanguage: 'chi' });
    mixedCatalog.search.catalogSearch.results[0].manifestations.push(id);
  }
  fixtures.kcls = fixtures.kcls.replace(catalogJson, JSON.stringify(mixedCatalog));
  // Stub only the external network, in the actual extension service worker.
  await worker.evaluate(fixtures => {
    globalThis.testNetwork = { fixtures, calls: [], outage: false, missing: false, delay: 900 };
    globalThis.fetch = async (url, options) => {
      const state = globalThis.testNetwork;
      state.calls.push({ url: String(url), credentials: options.credentials, referrerPolicy: options.referrerPolicy });
      await new Promise(resolve => setTimeout(resolve, state.delay));
      const library = ({'kcls.bibliocommons.com':'kcls','seattle.bibliocommons.com':'spl','sfpl.bibliocommons.com':'sfpl','oaklandlibrary.bibliocommons.com':'oakland','marinet.bibliocommons.com':'marin','smcl.bibliocommons.com':'smcl','orbiscascade-washington.primo.exlibrisgroup.com':'uw'})[new URL(url).hostname];
      const empty = '<script type="application/json" data-iso-key="_0">{"search":{"catalogSearch":{"results":[],"pagination":{"count":0,"pages":0}}},"entities":{"bibs":{}}}</script>';
      const emptyPrimo = '{"info":{"total":0},"docs":[]}';
      const body = library === 'uw' ? (state.missing ? emptyPrimo : state.fixtures.uw) : state.outage && library === 'spl' ? '<h1>Unavailable</h1>' : state.missing ? empty : state.fixtures[library];
      return new Response(body, { headers: { 'content-type': library === 'uw' ? 'application/json' : 'text/html' } });
    };
  }, fixtures);
  const popupUrl = `chrome-extension://${loaded.id}/popup.html`;
  let popup = await context.newPage();
  await popup.goto(popupUrl);
  await popup.getByRole('heading', { name: 'Set up your libraries', exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Choose libraries', exact: true }).count(), 1);
  assert.equal(await popup.getByRole('button', { name: /Check libraries|Connect/ }).count(), 0);
  assert.equal((await worker.evaluate(() => testNetwork.calls)).length, 0);
  assert.equal(await popup.locator('#refresh-button').isHidden(), true);
  const setupOpened = context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Choose libraries', exact: true }).click();
  const promptedSettings = await setupOpened;
  await promptedSettings.waitForURL(`chrome-extension://${loaded.id}/settings.html`);
  await promptedSettings.close();
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${loaded.id}/settings.html`);
  await setup.getByText('Find books across your libraries.', { exact: true }).waitFor();
  assert.equal(await setup.locator('.brand-mark').evaluate(img => img.currentSrc.endsWith('/icons/book-48.png')), true);
  await setup.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await setup.locator('.brand-mark').evaluate(img => img.currentSrc.endsWith('/icons/book-48.png')), true);
  await setup.emulateMedia({ colorScheme: 'light' });
  assert.match(await setup.locator('#version').textContent(), /^v\d+\.\d+\.\d+$/);
  await setup.locator('#zip-code').fill('98052');
  await setup.getByRole('button', { name: 'Find libraries', exact: true }).click();
  await setup.locator('#library-list .library-choice').nth(1).waitFor({ state: 'attached' });
  assert.equal(await setup.locator('#library-list .library-choice').count(), 3);
  assert.deepEqual(await setup.locator('#library-list .library-choice strong').allTextContents(), [
    'King County Library System (KCLS)', 'The Seattle Public Library (SPL)', 'University of Washington Libraries (UW)'
  ]);
  await setup.locator('#zip-code').fill('94129');
  await setup.getByRole('button', { name: 'Find libraries', exact: true }).click();
  await setup.locator('#library-list .library-choice').nth(4).waitFor({ state: 'attached' });
  assert.equal(await setup.locator('#library-list .library-choice').count(), 5);
  assert.deepEqual(await setup.locator('#library-list .library-choice strong').allTextContents(), [
    'San Francisco Public Library (SFPL)', 'Marin County Free Library (MARINet)', 'San Mateo County Libraries (SMCL)',
    'Oakland Public Library (OPL)', 'San José Public Library (SJPL)'
  ]);
  const choices = setup.locator('#library-list input[type=checkbox]');
  await choices.nth(0).check(); await choices.nth(1).check(); await choices.nth(2).check();
  assert.deepEqual(await setup.locator('#library-login-links a').evaluateAll(links => links.map(a => ({ href: a.href, target: a.target, rel: a.rel }))), ['sfpl', 'marinet', 'smcl'].map(host => ({ href: `https://${host}.bibliocommons.com/user/login`, target: '_blank', rel: 'noopener noreferrer' })));
  await choices.nth(3).click();
  assert.equal(await setup.locator('#library-list input:checked').count(), 3);
  await setup.getByRole('button', { name: 'Save selection', exact: true }).click();
  await setup.getByText('Saved. Library Lens will search these libraries.', { exact: true }).waitFor();
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('libraryPreferences')).libraryPreferences), { selectedIds: ['sfpl', 'marin', 'smcl'], preferredFormat: 'print' });
  await setup.reload();
  await setup.locator('#library-login-links a').nth(2).waitFor();
  assert.equal(await setup.locator('#library-login-links a').count(), 3);
  await setup.close();
  await popup.reload();
  await popup.getByText('Enter a title or ISBN.', { exact: true }).waitFor();
  for (const [id, value] of Object.entries({ title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204' })) await popup.locator(`#${id}`).fill(value);
  await popup.locator('#isbn').press('Enter');
  await popup.getByRole('link', { name: 'Place hold ↗' }).nth(2).waitFor();
  assert.equal(await popup.locator('.library').count(), 3);
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  assert.deepEqual((await worker.evaluate(() => testNetwork.calls)).map(call => new URL(call.url).hostname).sort(), [
    'marinet.bibliocommons.com', 'sfpl.bibliocommons.com', 'smcl.bibliocommons.com'
  ]);
  await worker.evaluate(async () => { testNetwork.missing = true; await chrome.storage.session.remove('latestLookup'); });
  await popup.locator('#book-form').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await popup.getByText('No matching book.', { exact: true }).nth(2).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  console.log('PASS: ZIP selection searches only the chosen three catalogs; results link to holds and unsupported purchase actions stay hidden');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ libraryPreferences: { zip: '98105', selectedIds: ['uw'] } });
    await chrome.storage.session.remove('latestLookup'); testNetwork.missing = false; testNetwork.calls = [];
  });
  await popup.reload();
  await popup.getByText('Enter a title or ISBN.', { exact: true }).waitFor();
  for (const [id, value] of Object.entries({ title: 'Futureproof', author: 'Kevin Roose', isbn: '9780593133361' })) await popup.locator(`#${id}`).fill(value);
  await popup.locator('#isbn').press('Enter');
  await popup.getByRole('heading', { name: 'University of Washington Libraries (UW)', exact: true }).waitFor();
  const uwRequest = popup.getByRole('link', { name: 'Place hold ↗', exact: true });
  await uwRequest.waitFor();
  assert.match(await uwRequest.getAttribute('href'), /\/nde\/fulldisplay\?docid=alma99331174504001451/);
  assert.equal(await popup.getByText('Other formats (1)', { exact: true }).count(), 1);
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  assert.equal(new URL((await worker.evaluate(() => testNetwork.calls[0].url))).hostname, 'orbiscascade-washington.primo.exlibrisgroup.com');
  await worker.evaluate(async () => { testNetwork.missing = true; await chrome.storage.session.remove('latestLookup'); });
  await popup.locator('#book-form').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await popup.getByRole('link', { name: 'Suggest a purchase ↗', exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  console.log('PASS: UW Primo lookup, exact-record request link, and official purchase suggestion handoff');
  await worker.evaluate(async () => {
    testNetwork.missing = false; testNetwork.calls = [];
    await chrome.storage.local.set({ libraryPreferences: { zip: '98101', selectedIds: ['kcls', 'spl'] } });
    await chrome.storage.session.remove('latestLookup');
  });
  await popup.reload();
  await popup.getByText('Enter a title or ISBN.', { exact: true }).waitFor();
  await popup.locator('#title').fill('Project Hail Mary');
  await popup.locator('#author').fill('Andy Weir');
  assert.equal(await popup.locator('#book-summary-meta').innerText(), 'Andy Weir');
  await popup.locator('#publication-date').fill('2021-05-04');
  assert.equal(await popup.locator('#book-summary-meta').innerText(), 'Andy Weir · May 2021');
  await popup.locator('#publisher').fill('Example Publisher');
  await popup.locator('#language').fill('English');
  await popup.locator('#isbn').fill('9780593135204');
  await popup.locator('#isbn').press('Enter');
  await popup.waitForFunction(() => parseFloat(document.querySelector('.query-time').textContent) >= .2);
  await popup.locator('body').screenshot({ path: resolve(results, 'popup-query-running.png') });
  await popup.getByText('0/247 available', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('link', { name: 'Place hold ↗' }).count(), 2);
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  assert.equal(await popup.getByText(/Other print matches|Check match|Gong zuo/).count(), 0);
  assert.equal(await popup.getByText('Other formats (1)', { exact: true }).count(), 1);

  assert.equal(await popup.locator('#book-details').evaluate(el => el.open), false);
  assert.equal(await popup.getByRole('heading', { name: 'King County Library System (KCLS)', exact: true }).count(), 1);
  assert.equal(await popup.getByRole('heading', { name: 'The Seattle Public Library (SPL)', exact: true }).count(), 1);
  assert.equal(await popup.locator('.result-title, .result > .result-meta').count(), 0);
  await popup.getByText('1st ed. / 2021', { exact: true }).first().waitFor();
  const rowGeometry = await popup.locator('.result').first().evaluate(el => {
    const row = el.getBoundingClientRect();
    return { height: row.height, overflow: el.scrollWidth > el.clientWidth, actionRight: el.querySelector('a').getBoundingClientRect().right, right: row.right };
  });
  assert.ok(rowGeometry.height < 65 && !rowGeometry.overflow && rowGeometry.actionRight <= rowGeometry.right + 1);
  assert.equal(await popup.locator('.brand-logo img').evaluate(img => img.currentSrc.endsWith('/icons/book-48.png')), true);
  await popup.locator('body').screenshot({ path: resolve(results, 'popup-found-light.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await popup.locator('.brand-logo img').evaluate(img => img.currentSrc.endsWith('/icons/book-48.png')), true);
  await popup.locator('body').screenshot({ path: resolve(results, 'popup-found-dark.png') });
  await popup.emulateMedia({ colorScheme: 'light' });

  assert.ok(parseFloat(await popup.locator('.query-time').first().innerText()) >= .8);
  const calls = await worker.evaluate(() => testNetwork.calls);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.credentials === 'omit' && call.referrerPolicy === 'no-referrer' && new URL(call.url).searchParams.get('searchType') === 'bl'));
  const refresh = () => popup.evaluate(() => document.querySelector('#book-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await worker.evaluate(async () => { const cache = (await chrome.storage.session.get('latestLookup')).latestLookup; for (const value of Object.values(cache.results)) value.savedAt -= 70000; await chrome.storage.session.set({ latestLookup: cache }); });
  await popup.reload();
  await popup.getByText('Enter a title or ISBN.', { exact: true }).waitFor();
  for (const [id, value] of Object.entries({title:'Project Hail Mary',author:'Andy Weir',publisher:'Example Publisher','publication-date':'2021-05-04',language:'English',isbn:'9780593135204'})) await popup.locator('#'+id).fill(value);
  await popup.locator('#isbn').press('Enter');
  await popup.getByText(/cached/, { exact: false }).first().waitFor();
  assert.equal((await worker.evaluate(() => testNetwork.calls)).length, 2);
  console.log('PASS: one combined query per library, visible live timer, no search button, and repeated lookup uses cache');
  // An ebook-only confirmed holding should also suppress purchase requests.
  await worker.evaluate(async () => {
    globalThis.mixedOriginal = testNetwork.fixtures.kcls;
    const raw = testNetwork.fixtures.kcls.match(/data-iso-key="_0">([\s\S]*?)<\/script>/)[1];
    const state = JSON.parse(raw);
    state.search.catalogSearch.results[0].representative = 'S82C2107066';
    state.search.catalogSearch.results[0].manifestations = ['S82C2107066'];
    testNetwork.fixtures.kcls = testNetwork.fixtures.kcls.replace(raw, JSON.stringify(state));
    await chrome.storage.session.remove('latestLookup');
  });
  await refresh();
  await popup.getByText('Other formats (1)', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  // Broad catalog hits alone are not proof the book is missing or matches.
  await worker.evaluate(async () => {
    const raw = mixedOriginal.match(/data-iso-key="_0">([\s\S]*?)<\/script>/)[1];
    const state = JSON.parse(raw);
    state.search.catalogSearch.results[0].representative = 'S82C9999991';
    state.search.catalogSearch.results[0].manifestations = ['S82C9999991', 'S82C9999992'];
    testNetwork.fixtures.kcls = mixedOriginal.replace(raw, JSON.stringify(state));
    await chrome.storage.session.remove('latestLookup');
  });
  await refresh();
  await popup.getByText('No confirmed match. Check the catalog.', { exact: true }).waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 0);
  assert.equal(await popup.getByText(/Other print matches|Check match|Gong zuo/).count(), 0);
  await worker.evaluate(() => { testNetwork.fixtures.kcls = mixedOriginal; });
  console.log('PASS: uncertain print/digital editions are hidden; confirmed print and ebook holdings suppress purchase; uncertain-only results direct to catalog');
  await worker.evaluate(async () => { testNetwork.outage = true; testNetwork.delay = 100; await chrome.storage.session.remove('latestLookup'); });
  await refresh();
  await popup.getByText(/catalog could not be read/).waitFor();
  assert.equal(await popup.getByRole('link', { name: 'Place hold ↗' }).count(), 1);
  console.log('PASS: one catalog failure stays independent and is not a missing-book result');
  await worker.evaluate(async () => { testNetwork.outage = false; testNetwork.missing = true; await chrome.storage.session.remove('latestLookup'); });
  await refresh();
  await popup.getByText('No matching book.', { exact: true }).first().waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Request purchase', exact: true }).count(), 2);
  assert.equal(await popup.getByRole('combobox').count(), 0);
  assert.equal(await popup.getByRole('button', { name: /Copy details|Open form|Check libraries/ }).count(), 0);
  assert.ok(await popup.getByRole('button', { name: 'Request purchase', exact: true }).first().evaluate(el => el.getBoundingClientRect().width) < 160);
  // Covers load crossorigin="anonymous" from an allowlisted CDN host, so the fixture answers with CORS headers.
  await context.route('https://m.media-amazon.com/images/I/fixture-cover.svg', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="84" height="124"><rect width="84" height="124" fill="#b6ca89"/><path d="M0 96 84 20v25L0 121Z" fill="#253f32"/><text x="8" y="20" font-family="sans-serif" font-size="9" font-weight="bold">PROJECT</text><text x="8" y="32" font-family="sans-serif" font-size="9" font-weight="bold">HAIL MARY</text></svg>' }));
  await popup.evaluate(async () => { const {renderCover} = await import('./lib/cover.js'); renderCover('https://m.media-amazon.com/images/I/fixture-cover.svg'); });
  await popup.locator('#book-cover').waitFor({state:'visible'});
  await popup.locator('body').screenshot({ path: resolve(results, 'popup-missing-light.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.locator('body').screenshot({ path: resolve(results, 'popup-missing-dark.png') });
  await popup.emulateMedia({ colorScheme: 'light' });
  console.log('PASS: missing-book UI has one purchase action per library and no audience/category selectors');

  // Real DOM extraction, no page script mocks. These fixtures have no network resources.
  const page = await context.newPage();
  await context.route('https://book-fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Book page</title></head><body></body></html>' }));
  await page.goto('https://book-fixture.example/book');
  await page.setContent(`<h1>A review headline</h1><script type="application/ld+json">${JSON.stringify({ '@graph': [
    { '@type': 'Person', '@id': '#author', name: 'Andy Weir' },
    { '@type': 'Book', name: 'Project Hail Mary', author: { '@id': '#author' }, isbn: '9780593135204', datePublished: '2021-05-04', publisher: { name: 'Ballantine Books' }, inLanguage: 'en' },
    { '@type': 'Book', name: 'A Second Book', author: 'Another Author', isbn: '9781524749095' }
  ] })}</script><form><input type="password" value="not-a-book"><input name="isbn" value="9780000000000"></form>`);
  let detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates.length, 2);
  assert.equal(detection.candidates[0].author, 'Andy Weir');
  assert.equal(detection.candidates[0].title, 'Project Hail Mary');
  assert.equal(detection.candidates[0].publisher, 'Ballantine Books');
  assert.equal(detection.candidates[0].publicationDate, '2021-05-04');
  await page.setContent('<h1>A recipe</h1><p>No book on this page.</p>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates.length, 0);
  await page.setContent('<h1>Project Hail Mary</h1><p>ISBN-13: 978-0-593-13520-4</p>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].isbn, '9780593135204');
  await page.setContent('<h1>Book roundup</h1><p>ISBN: 9780593135204</p><p>ISBN: 9781524749095</p>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates.length, 2);
  assert.equal(detection.candidates[0].title, '');
  await page.setContent('<h1 id="productTitle">Building AI Agents for Finance</h1><div id="bylineInfo"><span class="author"><a>Hanane Dupouy</a></span></div><table id="productDetails_detailBullets_sections1"><tr><th>Publisher</th><td>Packt Publishing</td></tr><tr><th>Publication date</th><td>June 6, 2025</td></tr><tr><th>Language</th><td>English</td></tr><tr><th>ISBN-10</th><td>1837022291</td></tr></table>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].publisher, 'Packt Publishing');
  assert.equal(detection.candidates[0].publicationDate, 'June 6, 2025');
  assert.equal(detection.candidates[0].language, 'English');
  await page.setContent('<h1>Book</h1><meta property="og:type" content="book"><img id="landingImage" src="https://m.media-amazon.com/images/test-cover.jpg"><meta property="book:isbn" content="1837022291">');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].coverUrl, 'https://m.media-amazon.com/images/test-cover.jpg');
  await page.setContent('<h1>Book</h1><meta property="og:type" content="book">');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].coverUrl || '', '');
  await page.setContent('<h1 id="productTitle">Example Book</h1><div id="tmmSwatches"><span class="a-button-selected">Audiobook</span><span>Paperback</span></div>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.audioEdition, true);
  await page.setContent('<h1 id="productTitle">Example Book</h1><div id="tmmSwatches"><span>Audiobook</span><span class="a-button-selected">Paperback</span></div><script type="application/ld+json">{"@type":"Book","name":"Example Book","isbn":"9780593135204"}</script>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.audioEdition, false);
  await page.setContent('<h1 id="productTitle">Example Book</h1><span id="productSubtitle">Audible Audiobook – Unabridged</span>');
  assert.equal((await page.evaluate(extractBookCandidates)).audioEdition, true);
  await page.setContent('<h1>Example Book</h1><div id="tmmSwatches"><span class="selected" hidden>Audiobook</span><span class="a-button-selected">Kindle</span></div>');
  assert.equal((await page.evaluate(extractBookCandidates)).audioEdition, false);
  await page.setContent('<h1>Example Book</h1><script type="application/ld+json">{"@type":"Audiobook","name":"Example Book","author":{"name":"Author"}}</script>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.audioEdition, true);
  await page.setContent('<h1>Example Book</h1><script type="application/ld+json">[{"@type":"Book","name":"Example Book","isbn":"9780593135204"},{"@type":"Audiobook","name":"Unrelated Recommendation"}]</script>');
  assert.equal((await page.evaluate(extractBookCandidates)).audioEdition, false);
  const bnHtml = `<h1>Project Hail Mary</h1><a href="/authors/andy-weir">Andy Weir</a><script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Project Hail Mary', author: 'https://www.barnesandnoble.com/b/contributor/andy-weir', hasVariant: [{ '@type': 'Product', sku: '9783135201' }, { '@type': 'Product', sku: '9780593135204' }] })}</script>`;
  await context.route('https://www.barnesandnoble.com/w/**', route => route.fulfill({ contentType: 'text/html', body: bnHtml }));
  await page.goto('https://www.barnesandnoble.com/w/project-hail-mary-andy-weir/1137456421?ean=9780593135204');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].title, 'Project Hail Mary');
  assert.equal(detection.candidates[0].author, 'Andy Weir');
  assert.equal(detection.candidates[0].isbn, '9780593135204');
  const goodreads = { '@context': 'https://schema.org', '@type': 'Book', name: 'Vibe', isbn: '9798217059706', author: { '@type': 'Person', name: 'Adam Grant' }, aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.25', ratingCount: '34' } };
  await context.route('https://www.goodreads.com/book/show/**', route => route.fulfill({ contentType: 'text/html', body: `<h1>Vibe</h1><script type="application/ld+json">${JSON.stringify(goodreads)}</script>` }));
  await page.goto('https://www.goodreads.com/book/show/249060851-vibe');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].title, 'Vibe');
  assert.equal(detection.candidates[0].author, 'Adam Grant');
  assert.equal(detection.candidates[0].isbn, '9798217059706');
  assert.deepEqual(detection.candidates[0].goodreadsRating, { value: 4.25, count: 34 });
  await context.route('https://www.amazon.com/Example/dp/**', route => route.fulfill({ contentType: 'text/html', body: '<h1 id="productTitle">Example Book</h1><div id="bylineInfo"><span class="author"><a>Example Author</a></span></div><script type="application/ld+json">{"@type":"Book","name":"Example Book","author":{"name":"Example Author"},"isbn":"9780593135204"}</script>' }));
  await page.goto('https://www.amazon.com/Example/dp/0593135202');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates[0].isbn, '9780593135204');
  assert.equal(detection.candidates[0].author, 'Example Author');
  await page.goto('https://book-fixture.example/amazon-title/1098107969');
  await page.setContent('<h1>Subtotal</h1><h1 id="title">Designing Machine Learning Systems: An Iterative Process</h1><div id="bylineInfo"><span class="author"><a>Chip Huyen</a></span></div><div id="detailBullets_feature_div"><li>ISBN-13: 978-1098107963</li><li>Edition: 3rd edition</li><li>Publication date: September 2026</li></div>');
  detection = await page.evaluate(extractBookCandidates);
  assert.equal(detection.candidates.length, 1);
  assert.equal(detection.candidates[0].title, 'Designing Machine Learning Systems: An Iterative Process');
  assert.equal(detection.candidates[0].author, 'Chip Huyen');
  assert.equal(detection.candidates[0].isbn, '1098107969');
  assert.equal(detection.candidates[0].edition, '3rd edition');
  assert.equal(detection.candidates[0].publicationDate, 'September 2026');
  console.log('PASS: real DOM extraction handles JSON-LD references, multiple books, labeled ISBNs, book formats, and non-book pages');

  // Use verified public form structures; no real account, submission, or personal data.
  const splForm = '<form id="s-la-askform-form_17516"><label>Title<input id="pquestion_17516" name="pquestion"></label><label>Author<input id="custom7_17516" name="custom7"></label><label>ISBN<input id="custom2_17516" name="custom2"></label><input id="custom8_17516" name="custom8"><textarea id="pdetails_17516" name="pdetails"></textarea><select id="custom5_17516" name="custom5"><option value="">Choose format</option><option value="1">Book</option></select><select id="custom9_17516" name="custom9"><option value="">Choose audience</option><option value="1">Adults</option></select><select id="custom3_17516" name="custom3"><option value="">Choose category</option><option value="2">Nonfiction</option></select><input id="library-card" value="untouched-card"><input type="email" value="untouched@example.test"><button type="submit">Submit</button></form>';
  const kclsForm = '<input name="identifier" value="untouched-login"><app-patron-request-create>' + ['Title', 'Author, Creator, Performer', 'ISBN, ISSN, UPC, OCLC Number', 'Publication Year', 'Publisher'].map((label, i) => `<mat-form-field><mat-label>${label}</mat-label><input id="field-${i}" type="${label === 'Publication Year' ? 'number' : 'text'}"></mat-form-field>`).join('') + '<mat-form-field><mat-label>Other Notes and Comments</mat-label><textarea id="notes"></textarea></mat-form-field>' + ['Select a Language', 'Select an Audience'].map((label, i) => `<mat-form-field><mat-label>${label}</mat-label><mat-select id="select-${i}" role="combobox" tabindex="0"><span class="mat-mdc-select-value-text"></span></mat-select></mat-form-field>`).join('') + '<mat-form-field><mat-label>Hold Pickup Library</mat-label><mat-select><span class="mat-mdc-select-value-text">Redmond</span></mat-select></mat-form-field></app-patron-request-create>';
  await context.route('https://www.spl.org/books-and-media/suggest-a-title', route => route.fulfill({ contentType: 'text/html', body: splForm }));
  await context.route('https://evgcatalog.kcls.org/patron-ui/en/requests/create', route => route.fulfill({ contentType: 'text/html', body: kclsForm }));
  const book = { title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204', publisher: 'Example Publisher', publicationDate: '2021-05-04', language: 'en', audience: 'Adults', category: 'Nonfiction', format: 'Print book' };
  await page.goto('https://www.spl.org/books-and-media/suggest-a-title');
  await page.evaluate(() => { window.submissions = 0; document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submissions++; }); });
  let pasted = await page.evaluate(([id, book, source]) => (0, eval)(`(${source})`)(id, book), ['spl', book, pasteBookDetails.toString()]);
  assert.equal(pasted.ok, true);
  assert.equal(await page.locator('#pquestion_17516').inputValue(), book.title);
  assert.equal(await page.locator('#custom7_17516').inputValue(), book.author);
  assert.equal(await page.locator('#custom2_17516').inputValue(), book.isbn);
  assert.equal(await page.locator('#custom8_17516').inputValue(), book.publicationDate);
  assert.match(await page.locator('#pdetails_17516').inputValue(), /Example Publisher/);
  assert.equal(await page.locator('#custom5_17516').inputValue(), '1');
  assert.equal(await page.locator('#custom9_17516').inputValue(), '1');
  assert.equal(await page.locator('#custom3_17516').inputValue(), '2');
  assert.equal(await page.locator('#library-card').inputValue(), 'untouched-card');
  assert.equal(await page.locator('input[type=email]').inputValue(), 'untouched@example.test');
  assert.equal(await page.evaluate(() => window.submissions), 0);
  await page.locator('#pquestion_17516').fill('My existing text');
  await page.locator('#custom7_17516').fill('');
  pasted = await page.evaluate(([id, book, source]) => (0, eval)(`(${source})`)(id, book), ['spl', book, pasteBookDetails.toString()]);
  assert.equal(pasted.ok, false);
  assert.equal(await page.locator('#custom7_17516').inputValue(), '');
  await page.goto('https://evgcatalog.kcls.org/patron-ui/en/requests/create');
  await page.evaluate(() => {
    window.inputOrder = []; document.addEventListener('input', event => window.inputOrder.push(event.target.id));
    for (const [id, label] of [['select-0', 'English'], ['select-1', 'Adult']]) {
      const select = document.getElementById(id); select.style.display = 'block'; select.style.height = '30px';
      select.addEventListener('click', () => {
        const option = document.createElement('mat-option'); option.setAttribute('role', 'option'); option.textContent = label; document.body.append(option);
        option.addEventListener('click', () => { select.querySelector('span').textContent = label; option.remove(); });
      });
    }
  });
  pasted = await page.evaluate(([id, book, source]) => (0, eval)(`(${source})`)(id, book), ['kcls', book, pasteBookDetails.toString()]);
  assert.equal(pasted.ok, true);
  assert.equal(await page.locator('input[name=identifier]').inputValue(), 'untouched-login');
  assert.equal(await page.locator('#field-3').inputValue(), '2021');
  assert.equal(await page.locator('#field-4').inputValue(), book.publisher);
  assert.equal(await page.locator('#select-0').innerText(), 'English');
  assert.equal(await page.locator('#select-1').innerText(), 'Adult');
  assert.match(await page.locator('#notes').inputValue(), /Requested format: Print book/);
  assert.match(await page.locator('mat-select').last().innerText(), /Redmond/);
  assert.equal((await page.evaluate(() => window.inputOrder)).at(-1), 'field-2');
  await page.locator('app-patron-request-create').evaluate(el => el.innerHTML = 'Sign in first');
  pasted = await page.evaluate(([id, book, source]) => (0, eval)(`(${source})`)(id, book), ['kcls', book, pasteBookDetails.toString()]);
  assert.equal(pasted.ok, false);
  await page.goto('https://book-fixture.example/not-a-form');
  pasted = await page.evaluate(([id, book, source]) => (0, eval)(`(${source})`)(id, book), ['spl', book, pasteBookDetails.toString()]);
  assert.equal(pasted.ok, false);
  console.log('PASS: Paste fills only verified book fields, refuses existing/missing/wrong-page fields, and never submits');

  // Exercise the real Request purchase -> new tab -> injected helper -> worker fill.
  const unrelated = await context.newPage();
  await unrelated.goto('https://evgcatalog.kcls.org/patron-ui/en/requests/create');
  assert.equal(await unrelated.locator('#library-lens-request-helper').count(), 0);
  const opened = context.waitForEvent('page');
  const kcls = popup.locator('.library').filter({ has: popup.getByRole('heading', { name: 'King County Library System (KCLS)', exact: true }) });
  await kcls.getByRole('button', { name: 'Request purchase', exact: true }).click();
  const requestTab = await opened;
  await requestTab.waitForURL('https://evgcatalog.kcls.org/patron-ui/en/requests/create');
  // Browser-initiated chrome.tabs.create navigation bypasses Playwright routing.
  // Revisit the observed official URL through Playwright to install the fixture.
  await requestTab.goto('https://evgcatalog.kcls.org/patron-ui/en/requests/create');
  await waitForHelper(requestTab, helper => helper.mode === 'closed' && Boolean(helper.button('Fill book details')));
  assert.equal(await unrelated.locator('#library-lens-request-helper').count(), 0);
  await popup.close();
  // Page scripts cannot reach the button (closed root) and a synthetic click on the host does nothing.
  assert.equal(await requestTab.evaluate(() => document.getElementById('library-lens-request-helper').shadowRoot), null);
  await requestTab.evaluate(() => document.getElementById('library-lens-request-helper').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal(await requestTab.locator('#field-0').inputValue(), '');
  // The helper icon is inlined; nothing in the package is web-accessible.
  assert.equal(await requestTab.evaluate(url => fetch(url).then(response => response.ok, () => false), `chrome-extension://${loaded.id}/icons/book-48.png`), false);
  // Simulate the not-yet-ready/login screen. Failure must retain the prepared book.
  await requestTab.locator('app-patron-request-create').evaluate(el => { window.savedMarkup = [...el.children].filter(child => child.id !== 'library-lens-request-helper').map(child => child.outerHTML).join(''); el.innerHTML = 'Sign in'; });
  await withHelper(requestTab, helper => helper.click(helper.button('Fill book details')));
  await waitForHelper(requestTab, helper => /Sign in and choose/.test(helper.text));
  await requestTab.waitForFunction(() => document.getElementById('library-lens-request-helper')?.dataset.anchor === 'waiting');
  const waiting = await requestTab.locator('#library-lens-request-helper').boundingBox();
  assert.ok(waiting.x < 20 && waiting.y > 350 && waiting.y < 650 && waiting.width <= 110);
  assert.ok(await worker.evaluate(async () => (await chrome.storage.session.get('pendingPurchaseBook')).pendingPurchaseBook));
  await requestTab.locator('app-patron-request-create').evaluate(el => { el.innerHTML = window.savedMarkup; });
  await requestTab.evaluate(() => {
    for (const [id, label] of [['select-0', 'English'], ['select-1', 'Adult']]) {
      const select = document.getElementById(id); select.style.display = 'block'; select.style.height = '30px';
      select.addEventListener('click', () => {
        const option = document.createElement('mat-option'); option.setAttribute('role', 'option'); option.textContent = label; document.body.append(option);
        option.addEventListener('click', () => { select.querySelector('span').textContent = label; option.remove(); });
      });
    }
  });
  await requestTab.addStyleTag({ content: 'body{font:15px system-ui;padding:30px;background:#fafafa}mat-form-field{display:block;margin:15px 0;max-width:620px}mat-label{display:block;font-size:12px;color:#555}input,textarea{padding:10px;width:560px;border:1px solid #ccc;border-radius:5px}mat-select{padding:10px;border:1px solid #ccc;border-radius:5px}' });
  // Restoring the form can preserve scroll anchoring from the temporary login
  // layout. Put the tested field in view before requiring its right-side helper.
  await requestTab.locator('app-patron-request-create mat-form-field').first().scrollIntoViewIfNeeded();
  await requestTab.waitForFunction(() => {
    const helper = document.getElementById('library-lens-request-helper');
    const first = document.querySelector('app-patron-request-create mat-form-field');
    return helper?.dataset.anchor === 'field-right' && helper.getBoundingClientRect().left >= first.getBoundingClientRect().right;
  }).catch(async error => {
    const placement = await requestTab.evaluate(() => ({
      viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY],
      anchor: document.getElementById('library-lens-request-helper')?.dataset.anchor,
      field: document.querySelector('app-patron-request-create mat-form-field')?.getBoundingClientRect().toJSON(),
      helper: document.getElementById('library-lens-request-helper')?.getBoundingClientRect().toJSON()
    }));
    throw new Error(`Helper placement failed: ${JSON.stringify(placement)}`, { cause: error });
  });
  const helperView = await withHelper(requestTab, helper => ({ text: helper.text, images: helper.img ? 1 : 0 }));
  assert.ok(helperView.text.includes('Library Lens') && helperView.text.includes('Extension'));
  assert.equal(helperView.images, 1);
  const placement = await requestTab.evaluate(() => {
    const helper = document.getElementById('library-lens-request-helper').getBoundingClientRect();
    const field = document.querySelector('app-patron-request-create mat-form-field').getBoundingClientRect();
    return { gap: helper.left - field.right, width: helper.width, top: Math.abs(helper.top - field.top) };
  });
  assert.ok(placement.gap >= 7 && placement.gap <= 10 && placement.width <= 110 && placement.top <= 8);
  await requestTab.locator('app-patron-request-create').evaluate(scope => {
    const replacement = document.createElement('app-patron-request-create');
    replacement.innerHTML = [...scope.children].filter(child => child.id !== 'library-lens-request-helper').map(child => child.outerHTML).join('');
    scope.replaceWith(replacement);
  });
  await requestTab.waitForFunction(() => {
    const helper = document.getElementById('library-lens-request-helper');
    return helper?.dataset.anchor === 'field-right' && helper.getBoundingClientRect().left >= document.querySelector('app-patron-request-create mat-form-field').getBoundingClientRect().right;
  });
  // Replacement models Angular rebuilding the component. Restore only fixture dropdown handlers.
  await requestTab.evaluate(() => {
    for (const [id, label] of [['select-0', 'English'], ['select-1', 'Adult']]) {
      const select = document.getElementById(id);
      select.addEventListener('click', () => {
        const option = document.createElement('mat-option'); option.setAttribute('role', 'option'); option.textContent = label; document.body.append(option);
        option.addEventListener('click', () => { select.querySelector('span').textContent = label; option.remove(); });
      });
    }
  });
  await withHelper(requestTab, helper => helper.evaluate(helper.status, 'function () { this.textContent = ""; }'));
  const inlineIcon = 'function () { return this.naturalWidth === 48 && this.currentSrc.startsWith("data:image/png;base64,"); }';
  await waitForHelper(requestTab, helper => helper.evaluate(helper.img, inlineIcon));
  await requestTab.screenshot({ path: resolve(results, 'kcls-floating-helper.png'), fullPage: true });
  await requestTab.locator('#library-lens-request-helper').screenshot({ path: resolve(results, 'helper-light.png') });
  await requestTab.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await withHelper(requestTab, helper => helper.evaluate(helper.img, inlineIcon)), true);
  await requestTab.locator('#library-lens-request-helper').screenshot({ path: resolve(results, 'helper-dark.png') });
  await requestTab.emulateMedia({ colorScheme: 'light' });
  await withHelper(requestTab, helper => helper.click(helper.button('Fill book details')));
  await requestTab.locator('#library-lens-request-helper').waitFor({ state: 'hidden' });
  assert.equal(await requestTab.locator('#field-0').inputValue(), 'Project Hail Mary');
  assert.equal(await requestTab.locator('#field-3').inputValue(), '2021');
  assert.equal(await requestTab.locator('#field-4').inputValue(), 'Example Publisher');
  assert.equal(await requestTab.locator('#select-0').innerText(), 'English');
  assert.equal(await requestTab.locator('#select-1').innerText(), 'Adult');
  assert.match(await requestTab.locator('mat-select').last().innerText(), /Redmond/);
  assert.equal(await requestTab.locator('input[name=identifier]').inputValue(), 'untouched-login');
  assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('pendingPurchaseBook')).pendingPurchaseBook), undefined);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('latestLookup')).latestLookup), undefined);
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(null)), { libraryPreferences: { selectedIds: ['kcls', 'spl'], preferredFormat: 'print' } });
  assert.deepEqual(await worker.evaluate(() => chrome.storage.sync.get(null)), {});
  await requestTab.reload();
  assert.equal(await requestTab.locator('#library-lens-request-helper').count(), 0);
  popup = await context.newPage();
  await popup.goto(popupUrl);
  console.log('PASS: KCLS floating helper works after popup closes, ignores page-script clicks, retains on failure, fills metadata/default Adult, clears on success, and never appears in unrelated tabs');

  // SPL follows the same complete flow, including asynchronously inserted form fields.
  await popup.evaluate(async book => { const { rememberBook } = await import('./lib/pending.js'); await rememberBook('spl', book); }, book);
  await context.route('https://www.spl.org/books-and-media/suggest-a-title', route => route.fulfill({ contentType: 'text/html', body: '<main>Loading request form</main>' }));
  const beforeLiveSpl = errors.length;
  const splOpened = context.waitForEvent('page');
  const openedResponse = await popup.evaluate(async () => {
    const { pendingBook } = await import('./lib/pending.js');
    return chrome.runtime.sendMessage({ type: 'OPEN_REQUEST', entryId: (await pendingBook()).id });
  });
  assert.equal(openedResponse.ok, true);
  const splTab = await splOpened;
  await splTab.waitForURL('https://www.spl.org/books-and-media/suggest-a-title');
  await splTab.goto('https://www.spl.org/books-and-media/suggest-a-title');
  // Discard only live SPL dependency errors from the unrouteable initial navigation.
  for (let i = errors.length - 1; i >= beforeLiveSpl; i--) {
    if (errors[i].url === splTab.url() && /^(jQuery|\$) is not defined$/.test(errors[i].message)) errors.splice(i, 1);
  }
  await waitForHelper(splTab, helper => Boolean(helper.button('Fill book details')));
  await popup.close();
  await splTab.waitForFunction(() => document.getElementById('library-lens-request-helper')?.dataset.anchor === 'waiting');
  await splTab.evaluate(markup => {
    document.querySelector('main').innerHTML = markup;
    document.body.style.padding = '150px';
    window.submissions = 0;
    document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submissions++; });
  }, splForm);
  await splTab.waitForFunction(() => document.getElementById('library-lens-request-helper')?.dataset.anchor === 'field-right');
  await withHelper(splTab, helper => helper.click(helper.button('Fill book details')));
  await splTab.locator('#library-lens-request-helper').waitFor({ state: 'hidden' });
  assert.equal(await splTab.locator('#pquestion_17516').inputValue(), book.title);
  assert.equal(await splTab.locator('#custom7_17516').inputValue(), book.author);
  assert.equal(await splTab.locator('#custom2_17516').inputValue(), book.isbn);
  assert.equal(await splTab.locator('#custom9_17516').inputValue(), '1');
  assert.equal(await splTab.locator('#custom5_17516').inputValue(), '1');
  assert.equal(await splTab.locator('#library-card').inputValue(), 'untouched-card');
  assert.equal(await splTab.evaluate(() => window.submissions), 0);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('pendingPurchaseBook')).pendingPurchaseBook), undefined);
  console.log('PASS: SPL opens directly and uses the same floating helper after popup closes and delayed form insertion');
  popup = await context.newPage();
  await popup.goto(popupUrl);

  await popup.evaluate(async book => { const { rememberBook } = await import('./lib/pending.js'); await rememberBook('spl', book); }, book);
  await popup.reload();
  await popup.getByRole('heading', { name: 'Prepared for SPL' }).waitFor();
  await popup.evaluate(() => {
    // The real DOM paste routine was checked above. Here simulate Chrome's
    // injection response to test the popup's clearing rule with real session storage.
    chrome.tabs.query = async () => [{ id: 999, url: 'https://www.spl.org/books-and-media/suggest-a-title' }];
    chrome.scripting.executeScript = async () => [{ result: { ok: false, message: 'Form not ready (test)' } }];
  });
  await popup.getByRole('button', { name: 'Paste book details', exact: true }).click();
  await popup.getByText('Form not ready (test)', { exact: true }).waitFor();
  assert.ok(await popup.evaluate(async () => (await chrome.storage.session.get('pendingPurchaseBook')).pendingPurchaseBook));
  await popup.evaluate(() => { chrome.scripting.executeScript = async () => [{ result: { ok: true } }]; });
  await popup.getByRole('button', { name: 'Paste book details', exact: true }).click();
  await popup.locator('#pending-request').waitFor({ state: 'hidden' });
  assert.equal(await popup.evaluate(async () => (await chrome.storage.session.get('pendingPurchaseBook')).pendingPurchaseBook), undefined);
  console.log('PASS: popup retains the book on failed injection and clears it on success (simulated injection responses)');

  // Source trust gate: mock only Chrome's clicked-tab extraction boundary.
  const locXml = await readFile(resolve(root, 'tests/fixtures/loc.xml'), 'utf8');
  await worker.evaluate(xml => {
    const original = globalThis.fetch;
    globalThis.locChecks = { xml, calls: 0, mode: 'match' };
    globalThis.fetch = async (url, options) => {
      if (new URL(url).origin !== 'https://lx2.loc.gov') return original(url, options);
      locChecks.calls++;
      if (locChecks.mode === 'outage') throw new Error('Synthetic outage');
      const body = locChecks.mode === 'missing' ? '<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><numberOfRecords>0</numberOfRecords></searchRetrieveResponse>' : locChecks.xml;
      return new Response(body, { headers: { 'content-type': 'application/xml' } });
    };
  }, locXml);
  const sourceBook = { title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204', publisher: '<img src=x onerror=alert(1)>', coverUrl: 'https://attacker.example/tracker' };
  const sourcePopup = async (url, candidate = sourceBook, extractionDelay = 0) => {
    const tab = await context.newPage();
    await tab.addInitScript(({ url, candidate, extractionDelay }) => {
      chrome.tabs.query = async () => [{ id: 999, url }];
      chrome.scripting.executeScript = async () => { if (extractionDelay) await new Promise(resolve => setTimeout(resolve, extractionDelay)); globalThis.sourceExtractions = (globalThis.sourceExtractions || 0) + 1; return [{ result: { candidates: candidate ? [candidate] : [], audioEdition: Boolean(candidate?.audioEdition) } }]; };
    }, { url, candidate, extractionDelay });
    await tab.goto(popupUrl);
    return tab;
  };
  // Parser must ignore the first ebook record's invalid and related-item ISBN.
  const parsed = await popup.evaluate(async ({ book, xml }) => {
    const { corroborateBook } = await import('./lib/verification.js');
    return corroborateBook(book, xml);
  }, { book: sourceBook, xml: locXml });
  assert.equal(parsed.publisher, 'Ballantine Books,');
  assert.equal(parsed.isbn, sourceBook.isbn);
  assert.equal(parsed.coverUrl, undefined);
  for (const xml of [locXml.replaceAll('Project Hail Mary', 'Unrelated title'), locXml.replaceAll('Weir, Andy,', 'Another Author'), locXml.replaceAll('<identifier type="isbn">9780593135204</identifier>', '<identifier type="isbn" invalid="yes">9780593135204</identifier>'), '<!DOCTYPE x [<!ENTITY x "bad">]><x/>', '<broken>']) {
    const rejected = await popup.evaluate(async ({ book, xml }) => {
      const { corroborateBook } = await import('./lib/verification.js');
      try { corroborateBook(book, xml); return false; } catch { return true; }
    }, { book: sourceBook, xml });
    assert.equal(rejected, true);
  }
  const trusted = await sourcePopup('https://www.amazon.com/Book/dp/0593135202', { ...sourceBook, coverUrl: '' }, 700);
  await trusted.getByText('Reading book details…', { exact: true }).waitFor();
  assert.equal(await trusted.locator('#book-form').isVisible(), false);
  assert.equal(await trusted.locator('#title').isVisible(), false);
  assert.equal(await trusted.locator('#libraries').isVisible(), false);
  await trusted.locator('body').screenshot({ path: resolve(results, 'popup-reading.png') });
  await trusted.locator('.request button').first().waitFor();
  assert.equal((await trusted.locator('#book-summary-meta').textContent()).trim(), sourceBook.author);
  assert.doesNotMatch(await trusted.locator('#book-summary-meta').textContent(), /ISBN|Print book|Goodreads/i);
  assert.equal(await worker.evaluate(() => locChecks.calls), 0);
  assert.equal(await trusted.locator('#book-details').evaluate(el => el.open), false);
  assert.equal(await trusted.locator('#title').isVisible(), false);
  const beforeRefresh = await worker.evaluate(() => testNetwork.calls.length);
  await trusted.getByRole('button', { name: 'Refresh book and library results' }).click();
  await trusted.waitForFunction(() => globalThis.sourceExtractions === 2);
  await trusted.locator('.request button').first().waitFor();
  await trusted.waitForFunction(() => document.querySelectorAll('.query-time').length > 0 && [...document.querySelectorAll('.query-time')].every(el => !el.textContent.includes('cached')));
  assert.equal(await worker.evaluate(() => testNetwork.calls.length), beforeRefresh + 2);
  assert.equal(await trusted.locator('#title').isVisible(), false);
  await trusted.close();
  const verified = await sourcePopup('https://www.goodreads.com/book/show/249060851-vibe', { ...sourceBook, coverUrl: '', goodreadsRating: { value: 4.25, count: 34 } });
  await verified.locator('.request button').first().waitFor();
  assert.equal(await verified.locator('#publisher').inputValue(), 'Ballantine Books,');
  assert.equal(await verified.locator('#book-cover').getAttribute('src'), null);
  assert.match(await verified.locator('#book-summary-meta').innerText(), /4\.25 stars from 34 ratings/);
  assert.equal(await worker.evaluate(() => locChecks.calls), 1);
  await verified.reload();
  await verified.locator('.request button').first().waitFor();
  assert.equal(await worker.evaluate(() => locChecks.calls), 1);
  await verified.close();
  const guidance = 'Library Lens works best on a single book page on Amazon or Barnes & Noble. Open this book there, then try again.';
  for (const [mode, candidate] of [['match', { ...sourceBook, title: 'Unrelated title' }], ['missing', sourceBook], ['outage', sourceBook], ['match', { ...sourceBook, isbn: '' }]]) {
    await worker.evaluate(async mode => { locChecks.mode = mode; await chrome.storage.session.remove('verifiedSourceBook'); }, mode);
    const before = await worker.evaluate(() => testNetwork.calls.length);
    const blocked = await sourcePopup('https://amazon.com.attacker.example/dp/0593135202', candidate);
    await blocked.getByText(guidance, { exact: true }).waitFor();
    assert.equal(await blocked.locator('#book-form').isVisible(), false);
    assert.equal(await blocked.locator('#libraries').isVisible(), false);
    assert.equal(await worker.evaluate(() => testNetwork.calls.length), before);
    await blocked.close();
  }
  console.log('PASS: trusted retailer bypass, Goodreads corroboration/rating, canonical metadata, ten-minute verification cache and early blocking on unsupported sites');
  // LoC does not cover every Goodreads edition. Selected catalog records
  // must confirm title + author independently; source ISBN alone is not proof.
  for (const mode of ['missing', 'outage']) {
    await worker.evaluate(async mode => {
      locChecks.mode = mode; testNetwork.missing = false; testNetwork.delay = 25;
      await chrome.storage.session.remove(['verifiedSourceBook', 'latestLookup']);
    }, mode);
    const before = await worker.evaluate(() => testNetwork.calls.length);
    const fallback = await sourcePopup('https://www.goodreads.com/en/book/show/123-example', sourceBook);
    await fallback.locator('.hold-action').first().waitFor();
    await fallback.waitForFunction(() => document.querySelector('#page-status').hidden);
    assert.equal(await fallback.locator('#isbn').inputValue(), sourceBook.isbn);
    assert.equal(await fallback.locator('.request button').count(), 0);
    assert.equal(await worker.evaluate(() => testNetwork.calls.length), before + 2, 'corroboration catalog requests are reused for display');
    await fallback.close();
  }
  await worker.evaluate(() => { testNetwork.missing = true; });
  console.log('PASS: Goodreads uses independently matching selected catalogs when LoC is missing or offline, without duplicate display requests');
  const beforeRetailer = await worker.evaluate(() => ({ loc: locChecks.calls, catalogs: testNetwork.calls.length }));
  for (const [url, candidate, expected, extractions] of [
    ['https://www.amazon.com/b/?_encoding=UTF8&node=132552011&bbn=283155', sourceBook, 'Choose a book from this list and open its product page. Then click Library Lens to check your libraries.', 0],
    ['https://www.amazon.com/s?k=books', sourceBook, 'Choose a book from this list and open its product page. Then click Library Lens to check your libraries.', 0],
    ['https://www.amazon.com/gp/help/customer/display.html', null, 'Open a single book’s product page on Amazon or Barnes & Noble, then try again.', 0],
    ['https://www.amazon.com/Earbuds/dp/B000000000', null, 'I couldn’t read book details here. Open the book on Amazon or Barnes & Noble, then try again.', 3]
  ]) {
    const retailer = await sourcePopup(url, candidate);
    await retailer.getByText(expected, { exact: true }).waitFor();
    assert.equal(await retailer.locator('#book-form').isVisible(), false);
    assert.equal(await retailer.locator('#libraries').isVisible(), false);
    assert.equal(await retailer.evaluate(() => globalThis.sourceExtractions || 0), extractions);
    await retailer.close();
  }
  assert.deepEqual(await worker.evaluate(() => ({ loc: locChecks.calls, catalogs: testNetwork.calls.length })), beforeRetailer);
  console.log('PASS: Amazon category/search pages request a single book; non-book pages explain purpose; no extraction or queries start on listings');
  const unsupportedMessage = 'Library Lens works best on a single book page on Amazon or Barnes & Noble. Open this book there, then try again.';
  const beforeUnsupported = await worker.evaluate(() => testNetwork.calls.length);
  for (const url of ['https://www.target.com/p/vibe-adam-grant/-/A-95287004', 'https://www.booksamillion.com/p/Vibe/Adam-Grant/9798217059706', 'https://www.walmart.com/ip/Vibe/123', 'https://www.goodreads.com/search?q=vibe']) {
    const unsupported = await sourcePopup(url, sourceBook);
    await unsupported.getByText(unsupportedMessage, { exact: true }).waitFor();
    assert.equal(await unsupported.evaluate(() => globalThis.sourceExtractions || 0), 0);
    await unsupported.close();
  }
  assert.equal(await worker.evaluate(() => testNetwork.calls.length), beforeUnsupported);
  console.log('PASS: Target, Books-A-Million, Walmart and non-book Goodreads pages show guidance without page extraction or catalog requests');
  const audioBook = { title: 'The AGI Chronicles: The Inside Story of the Race to Create an Artificial Superintelligence', author: 'Kevin Roose', isbn: '', publisher: 'Macmillan Audio', publicationDate: 'October 6, 2026', language: 'English', audioEdition: true };
  const audio = await sourcePopup('https://www.amazon.com/AGI-Chronicles-Inside-Artificial-Superintelligence/dp/B0GBXL3WTH/r', audioBook);
  await audio.locator('.request button').first().waitFor();
  assert.equal(await audio.locator('#book-form').isVisible(), true);
  assert.equal(await audio.locator('#libraries').isVisible(), true);
  assert.equal(await audio.locator('#author').inputValue(), 'Kevin Roose');
  assert.equal(await audio.locator('#isbn').inputValue(), '');
  assert.equal(await audio.locator('#publisher').inputValue(), 'Macmillan Audio');
  assert.equal(await audio.getByText(/This is an audiobook edition/).count(), 0);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('libraryPreferences')).libraryPreferences.preferredFormat), 'print');
  assert.equal(await audio.locator('.privacy').count(), 0);
  const optionsOpened = context.waitForEvent('page');
  await audio.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = await optionsOpened;
  await settings.waitForURL(`chrome-extension://${loaded.id}/settings.html`);
  await settings.getByRole('heading', { name: 'Privacy', exact: true }).waitFor();
  await settings.getByRole('heading', { name: 'Book covers', exact: true }).waitFor();
  await settings.screenshot({ path: resolve(results, 'settings-light.png'), fullPage: true });
  await settings.locator('#preferred-format').selectOption('audiobook');
  await settings.getByText('Saved. Audiobook will appear first.', { exact: true }).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('libraryPreferences')).libraryPreferences.preferredFormat), 'audiobook');
  await settings.reload();
  assert.equal(await settings.locator('#preferred-format').inputValue(), 'audiobook');
  await settings.getByText('Audiobook is your saved preference.', { exact: true }).waitFor();
  await settings.close();
  await audio.close();
  console.log('PASS: Amazon audiobook with no ISBN searches by title/author under the Print preference; settings retains independent format choices');

  await worker.evaluate(async () => {
    testNetwork.missing = false; testNetwork.calls = [];
    await chrome.storage.local.set({ libraryPreferences: { zip: '98101', selectedIds: ['kcls', 'spl'], preferredFormat: 'audiobook' } });
    const raw = testNetwork.fixtures.kcls.match(/data-iso-key="_0">([\s\S]*?)<\/script>/)[1];
    const state = JSON.parse(raw);
    const audio = structuredClone(state.entities.bibs.S82C2114334);
    audio.briefInfo.format = 'AB';
    audio.briefInfo.isbns = ['9780593135204'];
    state.entities.bibs.S82C9999993 = audio;
    state.search.catalogSearch.results[0].manifestations.push('S82C9999993');
    testNetwork.fixtures.kcls = testNetwork.fixtures.kcls.replace(raw, JSON.stringify(state));
    await chrome.storage.session.remove('latestLookup');
  });
  const preferredAudio = await sourcePopup('https://www.amazon.com/Example/dp/B000000000', { ...sourceBook, audioEdition: true });
  await preferredAudio.locator('.result-format').first().waitFor();
  assert.equal(await preferredAudio.locator('.result-format').first().textContent(), 'Audiobook');
  assert.equal(await preferredAudio.getByText('Other formats (2)', { exact: true }).count(), 1);
  assert.equal(await preferredAudio.getByText(/This is an audiobook edition/).count(), 0);
  await preferredAudio.close();
  console.log('PASS: audiobook preference accepts audiobook retailer pages and foregrounds confirmed audio holdings while keeping other formats');



  assert.deepEqual(errors, []);
  console.log('PASS: no JavaScript page errors. Screenshots: test-results/popup-{light,dark}.png');
} finally {
  await context.close();
}
