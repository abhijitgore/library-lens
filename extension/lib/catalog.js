import { cleanText, normalizeIsbn, matchBook } from './books.js';

export const LIBRARIES = Object.freeze({
  kcls: Object.freeze({
    id: 'kcls', name: 'King County Library System', short: 'KCLS',
    origin: 'https://kcls.bibliocommons.com', permission: 'https://kcls.bibliocommons.com/*',
    requestUrl: 'https://evgcatalog.kcls.org/patron-ui/en/requests/create',
    fscsKey: 'WA0059', supportsPurchase: true,
    policy: 'Purchase and loan requests share a form. Choose “Interlibrary Loan Opt Out” for purchase review only. KCLS generally considers books published within the last two years; eligibility and monthly limits apply.'
  }),
  spl: Object.freeze({
    id: 'spl', name: 'The Seattle Public Library', short: 'SPL',
    origin: 'https://seattle.bibliocommons.com', permission: 'https://seattle.bibliocommons.com/*',
    requestUrl: 'https://www.spl.org/books-and-media/suggest-a-title',
    fscsKey: 'WA0064', supportsPurchase: true,
    policy: 'Use Suggest a Title. SPL publishes a limit of ten suggestions per month across formats. Review the live form for current rules. A suggestion does not guarantee purchase.'
  }),
  sfpl: Object.freeze({
    id: 'sfpl', name: 'San Francisco Public Library', short: 'SFPL',
    origin: 'https://sfpl.bibliocommons.com', permission: 'https://sfpl.bibliocommons.com/*',
    fscsKey: 'CA0114', supportsPurchase: false
  }),
  oakland: Object.freeze({
    id: 'oakland', name: 'Oakland Public Library', short: 'OPL',
    origin: 'https://oaklandlibrary.bibliocommons.com', permission: 'https://oaklandlibrary.bibliocommons.com/*',
    fscsKey: 'CA0081', supportsPurchase: false
  }),
  marin: Object.freeze({
    id: 'marin', name: 'Marin County Free Library', short: 'MARINet',
    origin: 'https://marinet.bibliocommons.com', permission: 'https://marinet.bibliocommons.com/*',
    fscsKey: 'CA0065', supportsPurchase: false
  }),
  smcl: Object.freeze({
    id: 'smcl', name: 'San Mateo County Libraries', short: 'SMCL',
    origin: 'https://smcl.bibliocommons.com', permission: 'https://smcl.bibliocommons.com/*',
    fscsKey: 'CA0120', supportsPurchase: false
  }),
  sjpl: Object.freeze({
    id: 'sjpl', name: 'San José Public Library', short: 'SJPL',
    origin: 'https://sjpl.bibliocommons.com', permission: 'https://sjpl.bibliocommons.com/*',
    fscsKey: 'CA0115', requestUrl: 'https://www.sjpl.org/purchase/', purchaseLinkOnly: true
  }),
  uw: Object.freeze({
    id: 'uw', name: 'University of Washington Libraries', short: 'UW',
    origin: 'https://orbiscascade-washington.primo.exlibrisgroup.com',
    permission: 'https://orbiscascade-washington.primo.exlibrisgroup.com/*',
    loginUrl: 'https://search.lib.uw.edu/account',
    requestUrl: 'https://washington.libwizard.com/f/uwlib-purchase',
    purchaseLinkOnly: true
  }),
});

export function searchUrl(library, query, searchType = 'smart') {
  if (library.id === 'uw') {
    const url = new URL('/nde/search', library.origin);
    url.search = new URLSearchParams({ query, tab: 'UW_default', search_scope: 'UW_EVERYTHING', lang: 'en', vid: '01ALLIANCE_UW:UW_NDE' }).toString();
    return url.href;
  }
  const url = new URL('/v2/search', library.origin);
  url.search = new URLSearchParams({ query, searchType }).toString();
  return url.href;
}

export function recordUrl(library, id) {
  if (library.id === 'uw') {
    if (!/^alma\d{8,20}$/.test(id)) throw new Error('Invalid catalog record');
    const url = new URL('/nde/fulldisplay', library.origin);
    url.search = new URLSearchParams({ docid: id, context: 'L', vid: '01ALLIANCE_UW:UW_NDE', lang: 'en', tab: 'UW_default', search_scope: 'UW_EVERYTHING' }).toString();
    return url.href;
  }
  if (!/^S\d+C\d+$/.test(id)) throw new Error('Invalid catalog record');
  return `${library.origin}/v2/record/${id}`;
}

export function parseCatalogHtml(html) {
  // Parse only inert application/json. Never execute or render library HTML.
  const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || [];
  let state;
  for (const script of scriptTags) {
    const start = script.slice(0, script.indexOf('>') + 1);
    if (!/\btype\s*=\s*["']application\/json["']/i.test(start) || !/\bdata-iso-key\s*=\s*["']_0["']/i.test(start)) continue;
    try { state = JSON.parse(script.slice(script.indexOf('>') + 1).replace(/<\/script\s*>$/i, '')); }
    catch { throw new Error('The catalog returned unreadable data. Open the catalog to check.'); }
    break;
  }
  const search = state?.search?.catalogSearch;
  if (!search || !Array.isArray(search.results) || search.isFetching || state?.errors?.libraryError) {
    throw new Error('The catalog could not be read. It may be unavailable or its page format may have changed.');
  }
  const count = search.pagination?.count;
  if (!Number.isInteger(count) || count < 0 || (count > 0 && search.results.length === 0) || (count === 0 && search.results.length > 0)) {
    throw new Error('The catalog returned incomplete search results. Please check its website.');
  }
  const records = [];
  const ids = new Set();
  for (const result of search.results) {
    if (typeof result === 'string') ids.add(result);
    else {
      if (typeof result?.representative === 'string') ids.add(result.representative);
      if (Array.isArray(result?.manifestations)) for (const id of result.manifestations) ids.add(id);
    }
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !/^S\d+C\d+$/.test(id)) continue;
    const bib = state.entities?.bibs?.[id];
    const info = bib?.briefInfo || state.entities?.catalogBibs?.[id]?.brief;
    if (!info || !cleanText(info.title)) continue;
    const availability = bib?.availability;
    records.push({
      id, title: cleanText(info.title), subtitle: cleanText(info.subtitle),
      authors: Array.isArray(info.authors) ? info.authors.filter(a => typeof a === 'string').slice(0, 8).map(a => cleanText(a)) : [],
      isbns: Array.isArray(info.isbns) ? info.isbns.map(normalizeIsbn).filter(Boolean) : [],
      format: cleanText(info.format, 40), language: cleanText(info.primaryLanguage, 40),
      year: cleanText(String(info.publicationDate || ''), 40), edition: cleanText(info.edition),
      holdable: bib?.policy?.holdable === true,
      availability: availability && typeof availability === 'object' ? {
        status: cleanText(availability.status, 80), statusType: cleanText(availability.statusType, 80),
        localisedStatus: cleanText(availability.localisedStatus, 80),
        availableCopies: nonnegativeCount(availability.availableCopies),
        totalCopies: nonnegativeCount(availability.totalCopies), heldCopies: nonnegativeCount(availability.heldCopies),
        onOrderCopies: nonnegativeCount(availability.onOrderCopies), libraryUseOnly: availability.libraryUseOnly === true
      } : null
    });
  }
  if (count > 0 && records.length === 0) throw new Error('The catalog results could not be interpreted. Please check its website.');
  return { records, count, complete: search.pagination?.pages === 1 || count === 0, query: cleanText(search.query, 500) };
}

export function primoSearchUrl(library, book) {
  const url = new URL('/primaws/rest/pub/pnxs', library.origin);
  const title = cleanText(book.title).split(':')[0].replace(/[;,]/g, ' ').trim();
  const author = cleanText(book.author).replace(/[;,]/g, ' ').trim();
  const isbn = normalizeIsbn(book.isbn);
  const q = isbn ? `isbn,exact,${isbn}` : [title && `title,contains,${title}`, author && `creator,contains,${author}`].filter(Boolean).join(';');
  if (!q) throw new Error('Enter a book title or a valid ISBN.');
  url.search = new URLSearchParams({
    vid: '01ALLIANCE_UW:UW_NDE', tab: 'UW_default', scope: 'UW_EVERYTHING',
    q, lang: 'eng', offset: '1', limit: '30', view: 'brief'
  }).toString();
  return url.href;
}

export function parsePrimoJson(json) {
  const payload = typeof json === 'string' ? JSON.parse(json) : json;
  if (!payload || !Array.isArray(payload.docs) || !payload.info || !Number.isFinite(payload.info.total)) {
    throw new Error('The UW catalog could not be read. It may be unavailable or its page format may have changed.');
  }
  const records = [];
  for (const doc of payload.docs) {
    const pnx = doc?.pnx;
    const display = pnx?.display;
    const type = first(display?.type).toLowerCase();
    const displayFormat = first(display?.format).toLowerCase();
    const format = type === 'pbooks' ? 'BK'
      : /^(?:ebooks?|e-books?)$/.test(type) || /online resource/i.test(displayFormat) ? 'EBOOK'
        : /^(?:audiobooks?|audio books?)$/.test(type) || /^(?:audiobook|downloadable audiobook|audio book)$/i.test(displayFormat) ? 'AB'
          : '';
    if (!format) continue;
    const id = first(pnx?.control?.recordid);
    if (!/^alma\d{8,20}$/.test(id)) continue;
    const title = cleanText(first(display?.title));
    if (!title) continue;
    const creators = [...(array(display?.creator)), ...(array(pnx?.addata?.au))];
    const creator = creators
      .flatMap(value => String(value).split('$$Q'))
      .map(value => cleanText(value.replace(/\$\$[A-Z].*$/, '')))
      .filter(Boolean);
    const isbns = array(pnx?.addata?.isbn).map(normalizeIsbn).filter(Boolean);
    const delivery = doc.delivery || {};
    const rawAvailability = [first(delivery.availability), first(delivery.displayedAvailability)].join(' ').toLowerCase();
    const status = /unavailable|not_available|loaned|checked_out/.test(rawAvailability) ? 'UNAVAILABLE'
      : /available/.test(rawAvailability) && !/unavailable|not_available/.test(rawAvailability) ? 'AVAILABLE'
        : '';
    const year = first(display?.creationdate) || first(pnx?.addata?.date);
    records.push({
      id, title, subtitle: '', authors: [...new Set(creator)].slice(0, 8), isbns,
      format, language: cleanText(first(display?.language), 40), year: cleanText(year, 40),
      edition: cleanText(first(display?.edition) || first(pnx?.addata?.edition), 100),
      // UW directs patrons to the record-level Request action for login, pickup, and eligibility.
      holdable: true,
      availability: { status, statusType: status, availableCopies: null, totalCopies: null, heldCopies: null, onOrderCopies: null, libraryUseOnly: false }
    });
  }
  // A saturated page containing only articles or non-local resources is not proof that UW has no book.
  const saturated = payload.docs.length >= 30 && payload.info.total > 0;
  return { records, count: records.length || (saturated ? 1 : 0), complete: !saturated && payload.docs.length < 30 };
}

function array(value) { return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; }
function first(value) { return array(value)[0] || ''; }

function nonnegativeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function availabilityLabel(record) {
  const a = record.availability;
  if (!a) return { text: 'Availability unknown — check catalog', tone: 'neutral' };
  if (a.libraryUseOnly) return { text: 'Library use only', tone: 'neutral' };
  if (a.status === 'AVAILABLE' || a.statusType === 'AVAILABLE' || (a.availableCopies ?? 0) > 0) return { text: 'Available', tone: 'available' };
  const statusText = [a.status, a.statusType, a.localisedStatus].filter(Boolean).join(' ');
  if (a.onOrderCopies > 0 || /\bon[\s_-]*order\b/i.test(statusText)) return { text: 'On order', tone: 'neutral' };
  if (a.status === 'UNAVAILABLE' || a.statusType === 'UNAVAILABLE') return { text: 'All copies in use / unavailable', tone: 'waiting' };
  return { text: 'Check availability in catalog', tone: 'neutral' };
}

export const FORMAT_LABELS = { BK: 'Print book', LPRINT: 'Large print', EBOOK: 'eBook', AB: 'Audiobook', AB_CD: 'Audiobook CD', EAB: 'Downloadable audiobook' };

export function assessResults(book, result) {
  const ranked = result.records.map(record => ({ ...record, match: matchBook(book, record) }))
    .sort((a, b) => Number(b.match.exactIsbn) - Number(a.match.exactIsbn) || Number(b.match.strong) - Number(a.match.strong));
  const print = ranked.filter(record => record.format === 'BK');
  const otherFormats = ranked.filter(record => record.format !== 'BK');
  // Search engines can broaden ISBN searches; zero results is not inferred from weak matching.
  return { ...result, print, otherFormats, noResults: result.count === 0 };
}

async function fetchPage(url, signal, fetcher) {
  const response = await fetcher(url, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    headers: { Accept: 'text/html' }, signal
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'The catalog asked us to slow down. Try later or open its website.' : `The catalog returned an error (${response.status}). Try its website.`);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('The catalog returned an unexpected response.');
  const length = Number(response.headers.get('content-length'));
  if (length > 8000000) throw new Error('The catalog response was too large. Open its website.');
  const html = await readBoundedText(response, 8000000, 'The catalog response was too large. Open its website.');
  return parseCatalogHtml(html);
}

async function fetchPrimo(url, signal, fetcher) {
  const response = await fetcher(url, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    headers: { Accept: 'application/json' }, signal
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'The UW catalog asked us to slow down. Try later or open its website.' : `The UW catalog returned an error (${response.status}). Try its website.`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The UW catalog returned an unexpected response.');
  const length = Number(response.headers.get('content-length'));
  if (length > 4000000) throw new Error('The UW catalog response was too large. Open its website.');
  const body = await readBoundedText(response, 4000000, 'The UW catalog response was too large. Open its website.');
  try { return parsePrimoJson(body); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('The UW catalog returned unreadable data. Open its website to check.');
    throw error;
  }
}

// Enforce the size limit while reading so oversized responses are cancelled
// before the worker buffers or parses the full body.
async function readBoundedText(response, maxBytes, errorMessage) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The catalog returned an empty response. Open its website.');
  const decoder = new TextDecoder();
  const chunks = [];
  let byteCount = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(errorMessage);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

export function combinedQuery(book) {
  const phrase = value => cleanText(value).replace(/[\\"]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = phrase(cleanText(book.title).split(':')[0]);
  const author = phrase(book.author);
  const isbn = normalizeIsbn(book.isbn);
  const byTitle = title ? `title:("${title}")${author ? ` AND author:("${author}")` : ''}` : '';
  return [isbn ? `identifier:(${isbn})` : '', byTitle ? `(${byTitle})` : ''].filter(Boolean).join(' OR ');
}

export async function lookupLibrary(libraryId, book, { signal, fetcher = fetch } = {}) {
  if (typeof libraryId !== 'string' || !Object.hasOwn(LIBRARIES, libraryId)) throw new Error('Unknown library');
  const library = LIBRARIES[libraryId];
  if (!library) throw new Error('Unknown library');
  const title = cleanText(book.title);
  const author = cleanText(book.author);
  const isbn = normalizeIsbn(book.isbn);
  if (!title && !isbn) throw new Error('Enter a book title or a valid ISBN.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => controller.abort(), 20000);
  const query = combinedQuery({ title, author, isbn });
  try {
    if (libraryId === 'uw') {
      const url = primoSearchUrl(library, { title, author, isbn });
      const result = await fetchPrimo(url, controller.signal, fetcher);
      return { ...assessResults(book, { ...result, query: title || isbn }), searchUrl: searchUrl(library, title || isbn), checkedAt: new Date().toISOString() };
    }
    const url = searchUrl(library, query, 'bl');
    const result = await fetchPage(url, controller.signal, fetcher);
    return { ...assessResults(book, result), searchUrl: url, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(signal?.aborted ? 'Search cancelled.' : 'The catalog took too long to respond. Try again or open its website.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
