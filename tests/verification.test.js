import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedBookPage, isGoodreadsBookPage, supportedPageKind, retailerPageKind, locUrl, fetchLocXml, verifyBook, corroborateCatalogBook, SOURCE_FAILURE, UNSUPPORTED_SITE } from '../extension/lib/verification.js';

test('retailer listings and non-book pages have distinct guidance without weakening domain trust', () => {
  for (const url of ['https://www.amazon.com/b/?node=132552011&bbn=283155', 'https://www.amazon.com/s?k=books', 'https://amazon.in/gp/browse.html?node=123', 'https://www.barnesandnoble.com/b/books']) assert.equal(retailerPageKind(url), 'listing', url);
  assert.equal(retailerPageKind('https://www.amazon.com/gp/help/customer/display.html'), 'other');
  assert.equal(retailerPageKind('https://www.amazon.com/Book/dp/0593135202'), 'product');
  assert.equal(retailerPageKind('https://www.amazon.com/Earbuds/dp/B000000000'), 'product'); // DOM extraction still must find book metadata.
  assert.equal(retailerPageKind('https://www.target.com/p/-/A-81193200'), null);
  assert.equal(retailerPageKind('https://www.booksamillion.com/p/Project-Hail-Mary/Andy-Weir/9780593135204'), null);
  assert.equal(retailerPageKind('https://www.walmart.com/ip/Book/123'), null);
  assert.equal(retailerPageKind('https://amazon.com.attacker.example/b/'), null);
  assert.equal(retailerPageKind('http://amazon.com/b/'), null);
});

test('only Amazon and Barnes & Noble product pages bypass corroboration; Goodreads book pages are supported and verified', () => {
  for (const url of ['https://www.amazon.com/Book/dp/0593135202', 'https://amazon.co.uk/gp/product/0593135202', 'https://www.amazon.in/gp/aw/d/0593135202', 'https://www.barnesandnoble.com/w/project-hail-mary/123']) assert.equal(isTrustedBookPage(url), true, url);
  for (const url of ['https://www.target.com/p/-/A-81193200', 'https://www.booksamillion.com/p/Project-Hail-Mary/Andy-Weir/9780593135204', 'https://www.walmart.com/ip/Book/123', 'https://www.goodreads.com/book/show/249060851-vibe']) assert.equal(isTrustedBookPage(url), false, url);
  assert.equal(isGoodreadsBookPage('https://www.goodreads.com/book/show/249060851-vibe'), true);
  assert.equal(isGoodreadsBookPage('https://www.goodreads.com/book/show/22034.The_Godfather'), true);
  assert.equal(isGoodreadsBookPage('https://www.goodreads.com/en/book/show/60715378'), true);
  assert.equal(isGoodreadsBookPage('https://www.goodreads.com/en-US/book/show/60715378-designing-machine-learning-systems'), true);
  assert.equal(isGoodreadsBookPage('https://www.goodreads.com.attacker.example/en/book/show/60715378'), false);
  assert.equal(supportedPageKind('https://www.goodreads.com/book/show/22034.The_Godfather'), 'product');
  assert.equal(isGoodreadsBookPage('https://goodreads.com/search?q=vibe'), false);
  assert.equal(supportedPageKind('https://www.goodreads.com/book/show/249060851-vibe'), 'product');
  assert.equal(supportedPageKind('https://www.target.com/p/vibe'), 'unsupported');
  assert.equal(supportedPageKind('https://www.walmart.com/ip/vibe/123'), 'unsupported');
  assert.equal(supportedPageKind('https://www.booksamillion.com/p/Vibe/123'), 'unsupported');
  assert.match(UNSUPPORTED_SITE, /Amazon or Barnes & Noble/);
  for (const url of ['https://amazon.com.attacker.example/dp/0593135202', 'https://amazon.com@attacker.example/dp/0593135202', 'http://amazon.com/dp/0593135202', 'https://amazon.com:8443/dp/0593135202', 'https://seller.amazon.com/dp/0593135202', 'https://www.amazon.com/review/123', 'https://www.barnesandnoble.com/blog/123', 'https://www.walmart.com/reviews/123', 'https://unknown.example/book', 'javascript:alert(1)']) assert.equal(isTrustedBookPage(url), false, url);
});

test('catalog corroboration requires title and author independently of ISBN and replaces different-edition metadata', () => {
  const book = { title: 'The Purpose Driven Life: What on Earth Am I Here for?', author: 'Rick Warren', isbn: '9780310276999', publisher: 'Source publisher', publicationDate: '2007-02-20', format: 'Print book' };
  const record = { title: 'The Purpose-driven Life', authors: ['Warren, Rick'], isbns: ['9780310261704'], year: '2002', language: 'eng', edition: '', format: 'BK' };
  const verified = corroborateCatalogBook(book, { records: [record] });
  assert.equal(verified.isbn, '9780310261704');
  assert.equal(verified.publicationDate, '2002');
  assert.equal(verified.publisher, undefined);
  assert.throws(() => corroborateCatalogBook(book, { records: [{ ...record, title: 'Different Book', isbns: [book.isbn] }] }));
  assert.throws(() => corroborateCatalogBook(book, { records: [{ ...record, authors: ['Different Author'], isbns: [book.isbn] }] }));
  const exact = corroborateCatalogBook(book, { records: [{ ...record, isbns: [book.isbn] }] });
  assert.equal(exact.publicationDate, book.publicationDate);
  assert.equal(exact.title, book.title);
});

test('Goodreads can use a selected catalog when LoC has no record, is offline, or the edition has no ISBN', async () => {
  for (const isbn of ['9780310276999', '']) {
    const data = {}, calls = [];
    const storage = { get: async key => ({ [key]: data[key] }), set: async value => Object.assign(data, value) };
    const book = { title: 'The Purpose Driven Life', author: 'Rick Warren', isbn };
    const options = { storage, libraryIds: ['kcls'], request: async message => {
      calls.push(message);
      if (message.type === 'VERIFY_BOOK') return { ok: false };
      return { ok: true, result: { records: [{ title: book.title, authors: ['Warren, Rick'], isbns: ['9780310261704'], year: '2002' }] } };
    } };
    const verified = await verifyBook(book, options);
    assert.equal(verified.isbn, '9780310261704');
    assert.equal(calls.filter(call => call.type === 'LOOKUP').length, 1);
    await verifyBook(book, options);
    assert.equal(calls.filter(call => call.type === 'LOOKUP').length, 1, 'verified source cache avoids repeated checks');
  }
});

test('verification does not wait for stalled LoC when a catalog confirms the book; unrelated records fail closed', async () => {
  const book = { title: 'Example', author: 'Example Author', isbn: '9780593135204' };
  const storage = { get: async () => ({}), set: async () => {} };
  const confirmed = await verifyBook(book, { storage, libraryIds: ['spl'], request: async message => message.type === 'VERIFY_BOOK' ? new Promise(() => {}) : { ok: true, result: { records: [{ title: 'Example', authors: ['Example Author'], isbns: [book.isbn] }] } } });
  assert.equal(confirmed.isbn, book.isbn);
  await assert.rejects(verifyBook(book, { storage, libraryIds: ['spl'], request: async message => message.type === 'VERIFY_BOOK' ? { ok: false } : { ok: true, result: { records: [{ title: 'Unrelated', authors: ['Example Author'], isbns: [book.isbn] }] } } }), { message: SOURCE_FAILURE });
});

test('LoC query accepts only checksum-valid ISBNs at a fixed HTTPS endpoint', () => {
  const url = new URL(locUrl('978-0-593-13520-4'));
  assert.equal(url.origin, 'https://lx2.loc.gov');
  assert.equal(url.pathname, '/sru/lcdb');
  assert.equal(url.searchParams.get('query'), 'bath.isbn=9780593135204');
  for (const isbn of ['9780593135205', 'https://attacker.example', '9780593135204 OR x']) assert.throws(() => locUrl(isbn));
});

test('LoC fetch omits credentials/referrers, rejects redirects and enforces bounded streaming', async () => {
  let options;
  assert.equal(await fetchLocXml('9780593135204', async (url, input) => { options = input; return new Response('<xml/>', { headers: { 'content-type': 'application/xml' } }); }), '<xml/>');
  assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(128001)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchLocXml('9780593135204', async () => new Response(body, { headers: { 'content-type': 'text/xml' } })), /couldn’t verify/);
  assert.equal(cancelled, true);
  for (const response of [new Response('error', { status: 500 }), new Response('<html/>', { headers: { 'content-type': 'text/html' } })]) await assert.rejects(fetchLocXml('9780593135204', async () => response));
});

test('missing ISBN/title/author blocks before LoC and failures use the polite guidance', async () => {
  let calls = 0;
  const options = { storage: { get: async () => ({}) }, request: async () => { calls++; return { ok: false }; } };
  for (const book of [{ title: 'Book' }, { title: 'Book', isbn: '9780593135204' }, { author: 'Author', isbn: '9780593135204' }]) await assert.rejects(verifyBook(book, options), { message: SOURCE_FAILURE });
  assert.equal(calls, 0);
  await assert.rejects(verifyBook({ title: 'Book', author: 'Author', isbn: '9780593135204' }, options), { message: SOURCE_FAILURE });
});
