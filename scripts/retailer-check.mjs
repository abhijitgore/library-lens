// Real DOM parser regression checks using minimized public book-page elements.
// No network, retailer login, account data, or personal browser profile is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBookCandidates } from '../extension/lib/extract.js';
const { chromium } = await import(process.env.LIBRARY_LENS_PLAYWRIGHT || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = Object.fromEntries(await Promise.all(['amazon', 'amazon-audio', 'bn', 'goodreads'].map(async name => [name, await readFile(resolve(root, `tests/fixtures/retailers/${name}.html`), 'utf8')])));
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const context = await browser.newContext();
  let html;
  await context.route('**/*', route => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  const page = await context.newPage();
  let count = 0;
  async function check(label, url, markup, verify) {
    html = markup;
    await page.goto(url);
    const result = await page.evaluate(extractBookCandidates);
    await verify(result);
    count++;
    console.log(`PASS: ${label}`);
  }
  const amazon = 'https://www.amazon.com/LLM-Engineers-Handbook/dp/1836200072';
  await check('Amazon main title, both authors, role filtering, ISBN, publisher and date', amazon, fixtures.amazon, r => {
    assert.equal(r.candidates.length, 1);
    const b = r.candidates[0];
    assert.match(b.title, /^LLM Engineer/);
    assert.equal(b.author, 'Paul Iusztin, Maxime Labonne');
    assert.equal(b.isbn, '1836200072');
    assert.equal(b.publisher, 'Packt Publishing');
    assert.equal(b.publicationDate, 'October 22, 2024');
    assert.equal(r.audioEdition, false);
  });
  const recommended = `<script type="application/ld+json">${JSON.stringify([{ '@type': 'Book', name: "LLM Engineer's Handbook", isbn: '9781836200079' }, { '@type': 'Book', name: 'Unrelated recommendation', author: { name: 'Another author' }, isbn: '9780593135204' }])}</script>`;
  await check('Amazon ignores recommendation metadata and repairs a missing structured author', amazon, fixtures.amazon + recommended, r => {
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].author, 'Paul Iusztin, Maxime Labonne');
  });
  await check('Amazon Kindle ASIN without print ISBN can search by title and author', 'https://www.amazon.com/Example/dp/B000000000', '<h1 id="productTitle">Example Book</h1><div id="bylineInfo"><span class="author"><a>Example Author</a></span></div><div id="tmmSwatches"><span class="a-button-selected">Kindle</span></div>', r => {
    assert.equal(r.candidates[0].title, 'Example Book'); assert.equal(r.candidates[0].author, 'Example Author'); assert.equal(r.candidates[0].isbn, '');
  });
  await check('Amazon selected audiobook is recognized', amazon, fixtures.amazon.replace('a-button-selected">Paperback', 'a-button-selected">Audiobook'), r => assert.equal(r.audioEdition, true));
  await check('Supplied AGI Chronicles audio page extracts author/narrator, date and publisher without an ISBN', 'https://www.amazon.com/AGI-Chronicles-Inside-Artificial-Superintelligence/dp/B0GBXL3WTH/r', fixtures['amazon-audio'], r => {
    assert.equal(r.audioEdition, true); assert.equal(r.candidates.length, 1);
    const book = r.candidates[0];
    assert.match(book.title, /^The AGI Chronicles:/); assert.equal(book.author, 'Kevin Roose');
    assert.equal(book.isbn, ''); assert.equal(book.publisher, 'Macmillan Audio');
    assert.equal(book.publicationDate, 'October 6, 2026'); assert.equal(book.language, 'English');
  });
  const bn = 'https://www.barnesandnoble.com/w/llm-engineers-handbook-paul-iusztin/1145962303';
  for (const [ean, expected] of [['9781836200079', '9781836200079'], ['9781836200062', '9781836200062'], ['', '9781836200079']]) {
    await check(`B&N current product-group layout selects ${ean || 'default edition'}`, `${bn}${ean ? `?ean=${ean}` : ''}`, fixtures.bn, r => {
      assert.equal(r.candidates.length, 1); const b = r.candidates[0];
      assert.equal(b.author, 'Paul Iusztin, Maxime Labonne'); assert.equal(b.isbn, expected);
      assert.equal(b.publisher, 'Packt Publishing'); assert.equal(b.publicationDate, '2024-10-22');
      assert.match(b.coverUrl, new RegExp(`${expected}_p0`));
    });
  }
  await check('B&N legacy Book schema resolves author references', bn, '<h1>Example Book</h1><script type="application/ld+json">{"@graph":[{"@type":"Person","@id":"#author","name":"Example Author"},{"@type":"Book","name":"Example Book","author":{"@id":"#author"},"isbn":"9781836200079"}]}</script>', r => assert.equal(r.candidates[0].author, 'Example Author'));
  const gr = 'https://www.goodreads.com/book/show/56495.The_Purpose_Driven_Life';
  const verifyGr = r => {
    assert.equal(r.candidates.length, 1); const b = r.candidates[0];
    assert.equal(b.author, 'Rick Warren'); assert.equal(b.isbn, '9780310276999');
    assert.equal(b.publisher, 'Zondervan Publishing Company'); assert.equal(b.publicationDate, '2007-02-20');
    assert.deepEqual(b.goodreadsRating, { value: 3.99, count: 299409 });
  };
  await check('Goodreads current edition metadata and primary author/rating', gr, fixtures.goodreads, verifyGr);
  const withoutLd = fixtures.goodreads.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
  await check('Goodreads hydration supplies details when JSON-LD is absent', gr, withoutLd, verifyGr);
  await check('Goodreads locale-prefixed page uses only the current edition', gr.replace('/book/', '/en/book/'), withoutLd, verifyGr);
  const headingOnly = withoutLd.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, '');
  await check('Goodreads visible heading/byline allows catalog corroboration without ISBN', gr, headingOnly, r => {
    assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].author, 'Rick Warren'); assert.equal(r.candidates[0].isbn, '');
  });
  await check('Goodreads author URLs use the visible author name, not the URL', gr, headingOnly + '<script type="application/ld+json">{"@type":"Book","name":"The Purpose Driven Life: What on Earth Am I Here for?","author":"https://www.goodreads.com/author/show/711.Rick_Warren","isbn":"9780310276999"}</script>', r => assert.equal(r.candidates[0].author, 'Rick Warren'));
  await check('Goodreads recommendation metadata never replaces the primary book', gr, headingOnly + '<script type="application/ld+json">{"@type":"Book","name":"Unrelated recommendation","author":{"name":"Another author"},"isbn":"9780593135204"}</script><p>A review mentions ISBN: 9780593135204</p>', r => {
    assert.equal(r.candidates.length, 1); assert.match(r.candidates[0].title, /^The Purpose Driven Life/); assert.equal(r.candidates[0].isbn, '');
  });
  console.log(`All ${count} retailer parser checks passed.`);
} finally { await browser.close(); }
