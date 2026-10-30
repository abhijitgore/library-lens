import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LIBRARIES, lookupLibrary, parseCatalogHtml, parsePrimoJson, primoSearchUrl, assessResults, availabilityLabel, searchUrl, recordUrl, combinedQuery } from '../extension/lib/catalog.js';

const fixture = async name => readFile(new URL(`fixtures/${name}.html`, import.meta.url), 'utf8');
const jsonFixture = async name => readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8');
const htmlFor = state => `<html><script type="application/json" data-iso-key="_0">${JSON.stringify(state)}</script></html>`;
const emptyState = () => ({ search: { catalogSearch: { results: [], pagination: { count: 0, pages: 0 } } }, entities: { bibs: {} } });

test('captured KCLS and SPL public search structures expose print availability without account data', async () => {
  for (const library of ['kcls', 'spl']) {
    const result = assessResults({ title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204' }, parseCatalogHtml(await fixture(library)));
    assert.equal(result.noResults, false);
    assert.equal(result.print.length, 1);
    assert.equal(result.print[0].match.exactIsbn, true);
    assert.equal(result.print[0].availability.status, 'UNAVAILABLE');
    assert.match(recordUrl(LIBRARIES[library], result.print[0].id), /^https:\/\/(kcls|seattle)\.bibliocommons\.com\/v2\/record\/S\d+C\d+$/);
  }
});

test('Bay Area BiblioCommons catalogs use the supported public response format', async () => {
  for (const library of ['sfpl', 'oakland', 'marin', 'smcl', 'menlopark', 'sjpl']) {
    const parsed = parseCatalogHtml(await fixture(library === 'sjpl' ? 'smcl' : library));
    const result = assessResults({ title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204' }, parsed);
    assert.equal(result.noResults, false, library);
    assert.ok(result.print.some(record => record.match.exactIsbn), library);
    const exact = result.print.find(record => record.match.exactIsbn);
    assert.equal(exact.holdable, true, library);
    assert.match(exact.id, /^S\d+C\d+$/);
    assert.ok(recordUrl(LIBRARIES[library], exact.id).startsWith(`${LIBRARIES[library].origin}/v2/record/`));
  }
});

test('KCLS and SPL advertise integrated purchase preparation', () => {
  assert.deepEqual(Object.values(LIBRARIES).filter(library => library.supportsPurchase).map(library => library.id), ['kcls', 'spl']);
  assert.equal(LIBRARIES.sjpl.purchaseLinkOnly, true);
  assert.equal(LIBRARIES.sjpl.requestUrl, 'https://www.sjpl.org/purchase/');
});

test('UW Primo records map only book formats, preserve availability and open the exact public record', async () => {
  const result = parsePrimoJson(await jsonFixture('uw'));
  const assessed = assessResults({ title: 'Futureproof', author: 'Kevin Roose', isbn: '9780593133361' }, result);
  assert.equal(assessed.print.length, 1);
  assert.equal(assessed.print[0].match.exactIsbn, true);
  assert.equal(assessed.print[0].availability.status, 'AVAILABLE');
  assert.equal(assessed.print[0].holdable, true);
  assert.equal(assessed.otherFormats.length, 1);
  assert.equal(assessed.otherFormats[0].format, 'EBOOK');
  assert.equal(assessed.otherFormats[0].match.exactIsbn, false);
  assert.match(recordUrl(LIBRARIES.uw, assessed.print[0].id), /^https:\/\/orbiscascade-washington\.primo\.exlibrisgroup\.com\/nde\/fulldisplay\?docid=alma\d+&context=L/);
  assert.throws(() => recordUrl(LIBRARIES.uw, 'https://evil.example'));
  assert.equal(parsePrimoJson({ info: { total: 0 }, docs: [] }).count, 0);
  assert.throws(() => parsePrimoJson({ info: {}, docs: 'bad' }), /could not be read/);
});

test('UW Primo recognizes audiobook records for the audiobook preference', () => {
  const result = parsePrimoJson({ info: { total: 1 }, docs: [{ pnx: {
    control: { recordid: ['alma9912345678901234'] },
    display: { type: ['Audiobook'], title: ['Project Hail Mary'], creator: ['Andy Weir'], format: ['Unabridged audio'] },
    addata: { isbn: ['9780593135204'] }
  } }] });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].format, 'AB');
});

test('UW lookup uses the fixed anonymous Primo endpoint and links to its catalog search', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(await jsonFixture('uw'), { headers: { 'content-type': 'application/json' } });
  };
  const result = await lookupLibrary('uw', { title: 'Futureproof', author: 'Kevin Roose', isbn: '9780593133361' }, { fetcher });
  assert.equal(result.print.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, LIBRARIES.uw.origin);
  assert.equal(calls[0].url.pathname, '/primaws/rest/pub/pnxs');
  assert.equal(calls[0].url.searchParams.get('q'), 'isbn,exact,9780593133361');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(result.searchUrl, /\/nde\/search\?query=Futureproof/);
  const titleUrl = new URL(primoSearchUrl(LIBRARIES.uw, { title: 'Futureproof', author: 'Roose' }));
  assert.equal(titleUrl.searchParams.get('q'), 'title,contains,Futureproof;creator,contains,Roose');
  assert.equal(new URL(searchUrl(LIBRARIES.uw, 'Futureproof')).hostname, new URL(LIBRARIES.uw.origin).hostname);
});

test('outages, changed pages, incomplete data and malformed JSON never mean no results', () => {
  for (const html of [
    '<html><h1>The page is temporarily unavailable</h1></html>',
    '<script type="application/json" data-iso-key="_0">broken</script>',
    htmlFor({ search: { catalogSearch: { results: [], pagination: { count: 2 } } } }),
    htmlFor({ search: { catalogSearch: { results: [], isFetching: true, pagination: { count: 0 } } } }),
    htmlFor({ ...emptyState(), errors: { libraryError: 'unavailable' } })
  ]) assert.throws(() => parseCatalogHtml(html));
  assert.equal(parseCatalogHtml(htmlFor(emptyState())).count, 0);
});

test('lookup combines ISBN and title in one anonymous fixed-origin GET', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(await fixture('kcls'), { headers: { 'content-type': 'text/html' } });
  };
  const book = { title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204' };
  const result = await lookupLibrary('kcls', book, { fetcher });
  assert.equal(result.print.length, 1);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('query'), 'identifier:(9780593135204) OR (title:("Project Hail Mary") AND author:("Andy Weir"))');
  assert.equal(url.searchParams.get('searchType'), 'bl');
  assert.equal(url.origin, LIBRARIES.kcls.origin);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].options.redirect, 'error');
});

test('combined search supports ISBN-only and title-only books without empty clauses', () => {
  assert.equal(combinedQuery({ isbn: '9780593135204' }), 'identifier:(9780593135204)');
  assert.equal(combinedQuery({ title: 'Book: Subtitle' }), '(title:("Book"))');
});

test('an ISBN matching only a digital record never silently becomes a print match', async () => {
  const result = parseCatalogHtml(await fixture('kcls'));
  const ebook = result.records.find(record => record.format === 'EBOOK');
  const assessed = assessResults({ title: 'Project Hail Mary', isbn: '9780593135204', author: 'Andy Weir' }, { ...result, records: [ebook] });
  assert.equal(assessed.print.length, 0);
  assert.equal(assessed.otherFormats.length, 1);
  assert.equal(assessed.noResults, false);
});

test('unreadable catalog pages and rate limiting surface errors, not a purchase result', async () => {
  await assert.rejects(lookupLibrary('spl', { title: 'Missing', isbn: '9780593135204' }, { fetcher: async () =>
    new Response('<h1>Temporarily unavailable</h1>', { headers: { 'content-type': 'text/html' } })
  }), /could not be read/);
  await assert.rejects(lookupLibrary('spl', { title: 'Test' }, { fetcher: async () => new Response('', { status: 429 }) }), /slow down/);
  await assert.rejects(lookupLibrary('not-a-library', { title: 'Test' }), /Unknown library/);
});

test('oversized catalog responses are cancelled during streaming', async () => {
  let producedBytes = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      producedBytes += 4_000_000;
      controller.enqueue(new Uint8Array(4_000_000));
    },
    cancel() { cancelled = true; }
  });
  await assert.rejects(lookupLibrary('kcls', { title: 'Large response' }, { fetcher: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) }), /response was too large/);
  assert.equal(cancelled, true);
  assert.ok(producedBytes >= 8_000_000 && producedBytes <= 16_000_000); // A stream may prefetch one chunk before cancellation.
});

test('untrusted query text cannot change the library URL or create a record URL', () => {
  const url = new URL(searchUrl(LIBRARIES.spl, 'a&query=evil#<script>'));
  assert.equal(url.origin, 'https://seattle.bibliocommons.com');
  assert.equal(url.searchParams.get('query'), 'a&query=evil#<script>');
  assert.throws(() => recordUrl(LIBRARIES.spl, '//evil.test'));
});


test('BiblioCommons on-order metadata is retained and displayed when incoming copies are not yet available', () => {
  const state = { search: { catalogSearch: { results: [{ representative: 'S82C1234567' }], pagination: { count: 1, pages: 1 } } }, entities: { bibs: { S82C1234567: { briefInfo: { title: 'Vibe', authors: ['Grant, Adam'], isbns: ['9780593655307'], format: 'BK' }, availability: { status: 'UNKNOWN', statusType: 'UNKNOWN', localisedStatus: 'ON_ORDER', onOrderCopies: 164, totalCopies: 189, availableCopies: 0, heldCopies: 24 } } } } };
  const parsed = parseCatalogHtml(htmlFor(state));
  assert.equal(parsed.records[0].availability.localisedStatus, 'ON_ORDER');
  assert.equal(availabilityLabel(parsed.records[0]).text, 'On order');
});

test('availability handles reference, on-order, and unknown records without guessing', () => {
  assert.equal(availabilityLabel({ availability: null }).tone, 'neutral');
  assert.equal(availabilityLabel({ availability: { libraryUseOnly: true, status: 'AVAILABLE' } }).text, 'Library use only');
  assert.equal(availabilityLabel({ availability: { onOrderCopies: 3, totalCopies: 0 } }).text, 'On order');
  assert.equal(availabilityLabel({ availability: { onOrderCopies: 164, totalCopies: 189, availableCopies: 0, heldCopies: 24 } }).text, 'On order');
  assert.equal(availabilityLabel({ availability: { status: 'UNKNOWN', localisedStatus: 'ON_ORDER', totalCopies: 12 } }).text, 'On order');
  assert.equal(availabilityLabel({ availability: { onOrderCopies: 164, availableCopies: 3, totalCopies: 189 } }).text, 'Available');
  assert.equal(availabilityLabel({ availability: { status: 'NEW_STATUS' } }).text, 'Check availability in catalog');
});
