import { cleanText, normalizeIsbn, isbn13, matchBook, purchaseMetadata } from './books.js';

export const SOURCE_FAILURE = 'We couldn’t verify this book’s details. Please open the book on Amazon or Barnes & Noble and try again.';
export const LOC_ORIGIN = 'https://lx2.loc.gov';
const AMAZON = ['amazon.com', 'amazon.ca', 'amazon.co.uk', 'amazon.in', 'amazon.com.au', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.co.jp'];

function retailerHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const host = url.hostname.replace(/^www\./, '');
    return AMAZON.includes(host) || host === 'barnesandnoble.com' ? host : '';
  } catch { return ''; }
}

export const RETAILER_LISTING = 'Choose a book from this list and open its product page. Then click Library Lens to check your libraries.';
export const RETAILER_NOT_BOOK = 'I couldn’t read book details here. Open the book on Amazon or Barnes & Noble, then try again.';
export const UNSUPPORTED_SITE = 'Library Lens works best on a single book page on Amazon or Barnes & Noble. Open this book there, then try again.';
export const RETAILER_PRODUCT = 'Open a single book’s product page on Amazon or Barnes & Noble, then try again.';

export function retailerPageKind(value) {
  const host = retailerHost(value);
  if (!host) return null;
  if (isTrustedBookPage(value)) return 'product';
  const path = new URL(value).pathname;
  const listing = AMAZON.includes(host) ? /^\/(?:b|s)(?:\/|$)|^\/gp\/browse\.html$/i.test(path)
    : /^\/(?:b|s)(?:\/|$)/i.test(path);
  return listing ? 'listing' : 'other';
}

export function isGoodreadsBookPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['goodreads.com', 'www.goodreads.com'].includes(url.hostname.toLowerCase()) && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?book\/show\/\d+(?:[./-]|$)/i.test(url.pathname);
  } catch { return false; }
}

export function supportedPageKind(value) {
  if (isTrustedBookPage(value) || isGoodreadsBookPage(value)) return 'product';
  const retailer = retailerPageKind(value);
  return retailer || 'unsupported';
}

export function isTrustedBookPage(value) {
  try {
    const url = new URL(value);
    const host = retailerHost(value);
    if (!host) return false;
    if (AMAZON.includes(host)) return /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}(?:\/|$)/i.test(url.pathname);
    if (host === 'barnesandnoble.com') return /^\/w\/[^/]+/i.test(url.pathname);
    return false;
  } catch { return false; }
}

export function locUrl(value) {
  const isbn = normalizeIsbn(value);
  if (!isbn) throw new Error(SOURCE_FAILURE);
  const url = new URL('/sru/lcdb', LOC_ORIGIN);
  url.search = new URLSearchParams({ version: '1.1', operation: 'searchRetrieve', query: `bath.isbn=${isbn}`, recordSchema: 'mods', maximumRecords: '5' });
  return url.href;
}

// Runs in the worker. Fetch only the fixed LoC endpoint, with a hard byte budget.
export async function fetchLocXml(isbn, fetcher = fetch) {
  const response = await fetcher(locUrl(isbn), {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    headers: { Accept: 'application/xml, text/xml' }, signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || !/\b(?:application|text)\/xml\b/i.test(response.headers.get('content-type') || '') || !response.body) throw new Error(SOURCE_FAILURE);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256000) { await reader.cancel(); throw new Error(SOURCE_FAILURE); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

// XML is parsed inertly in the extension popup; never inserted into its HTML.
export function corroborateBook(book, xml) {
  if (typeof xml !== 'string' || xml.length > 256000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(SOURCE_FAILURE);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(SOURCE_FAILURE);
  const ns = 'http://www.loc.gov/mods/v3';
  const children = (parent, name) => [...parent.children].filter(el => el.namespaceURI === ns && el.localName === name);
  const text = (parent, name) => cleanText(children(parent, name)[0]?.textContent);
  if (!normalizeIsbn(book.isbn) || !cleanText(book.title) || !cleanText(book.author)) throw new Error(SOURCE_FAILURE);
  for (const mods of doc.getElementsByTagNameNS(ns, 'mods')) {
    const isbns = children(mods, 'identifier').filter(el => el.getAttribute('type') === 'isbn' && el.getAttribute('invalid') !== 'yes').map(el => normalizeIsbn(el.textContent)).filter(Boolean);
    if (!isbns.some(value => isbn13(value) === isbn13(book.isbn))) continue;
    const titleInfo = children(mods, 'titleInfo').find(el => !el.hasAttribute('type'));
    if (!titleInfo) continue;
    const title = [text(titleInfo, 'nonSort'), text(titleInfo, 'title')].filter(Boolean).join(' ');
    const authors = children(mods, 'name').filter(el => el.getAttribute('type') === 'personal' && (el.getAttribute('usage') === 'primary' || /\bauthor\b/i.test(children(el, 'role').map(role => role.textContent).join(' ')))).map(el => children(el, 'namePart').filter(part => part.getAttribute('type') !== 'date').map(part => part.textContent).join(' '));
    // Deliberately compare title/author without letting an ISBN match bypass them.
    if (!matchBook({ ...book, isbn: '' }, { title, authors, isbns: [] }).strong) continue;
    const origins = children(mods, 'originInfo');
    const publication = origins.find(el => el.getAttribute('eventType') === 'publication') || origins[0];
    const publisher = publication ? text(publication, 'publisher') || children(publication, 'agent').filter(el => /publisher/i.test(el.textContent)).map(el => text(el, 'namePart')).join(', ') : '';
    const language = children(mods, 'language').flatMap(el => children(el, 'languageTerm')).find(el => el.getAttribute('type') === 'code')?.textContent || '';
    return {
      title: cleanText([title, text(titleInfo, 'subTitle')].filter(Boolean).join(': ')),
      author: cleanText(authors.join('; ')), isbn: normalizeIsbn(book.isbn),
      publisher: cleanText(publisher), publicationDate: cleanText(origins.map(el => text(el, 'dateIssued')).find(Boolean), 40),
      language: cleanText(language, 80), edition: cleanText(origins.map(el => text(el, 'edition')).find(Boolean)), format: 'Print book'
    };
  }
  throw new Error(SOURCE_FAILURE);
}

// A catalog can verify a work even when LoC does not cover the Goodreads
// edition. ISBN alone never bypasses the independent title + author check.
export function corroborateCatalogBook(book, result) {
  const title = cleanText(book.title), author = cleanText(book.author);
  if (!title || !author || !Array.isArray(result?.records)) throw new Error(SOURCE_FAILURE);
  const matches = result.records.filter(record => matchBook({ title, author, isbn: '' }, record).strong);
  const exact = matches.find(record => normalizeIsbn(book.isbn) && record.isbns.some(value => isbn13(value) === isbn13(book.isbn)));
  if (exact) return { ...purchaseMetadata(book), title, author, isbn: normalizeIsbn(book.isbn) };
  const preferred = { 'Print book': ['BK', 'LPRINT'], eBook: ['EBOOK'], Audiobook: ['AB', 'AB_CD', 'EAB'] }[book.format] || [];
  const record = matches.find(record => preferred.includes(record.format)) || matches[0];
  if (!record) throw new Error(SOURCE_FAILURE);
  // A different edition verifies the work, not the source's ISBN/date/etc.
  // Replace edition-specific fields with the independent catalog record.
  return { title: cleanText(record.title), author: cleanText(record.authors.join('; ')), isbn: record.isbns.map(normalizeIsbn).find(Boolean) || '', publicationDate: cleanText(record.year, 40), language: cleanText(record.language, 80), edition: cleanText(record.edition) };
}

export async function verifyBook(book, { storage = chrome.storage.session, now = Date.now, request = message => chrome.runtime.sendMessage(message), libraryIds = [], isCurrent = () => true } = {}) {
  const key = JSON.stringify([cleanText(book.title), cleanText(book.author), normalizeIsbn(book.isbn)]);
  const cached = (await storage.get('verifiedSourceBook')).verifiedSourceBook;
  if (cached?.key === key && now() - cached.savedAt >= 0 && now() - cached.savedAt < 600000) return cached.book;
  if (!cleanText(book.title) || !cleanText(book.author)) throw new Error(SOURCE_FAILURE);
  const checks = [];
  if (normalizeIsbn(book.isbn)) checks.push((async () => {
    const response = await request({ type: 'VERIFY_BOOK', isbn: normalizeIsbn(book.isbn) });
    if (!response?.ok) throw new Error(SOURCE_FAILURE);
    return corroborateBook(book, response.xml);
  })());
  // Reuse the same bounded, fixed-origin catalog requests as the result view.
  // Parallel checks avoid waiting on LoC when a selected catalog already
  // confirms the book. Failed or unrelated results never verify a source.
  for (const libraryId of [...new Set(libraryIds)].slice(0, 3)) checks.push((async () => {
    const response = await request({ type: 'LOOKUP', libraryId, book: { title: cleanText(book.title), author: cleanText(book.author), isbn: normalizeIsbn(book.isbn) } });
    if (!response?.ok) throw new Error(SOURCE_FAILURE);
    return corroborateCatalogBook(book, response.result);
  })());
  let verified;
  try { verified = await Promise.any(checks); }
  catch { throw new Error(SOURCE_FAILURE); }
  if (isCurrent()) await storage.set({ verifiedSourceBook: { key, book: verified, savedAt: now() } });
  return verified;
}
