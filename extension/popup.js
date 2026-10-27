import { readBookPage } from './lib/read-page.js';
import { cleanText, normalizeIsbn, bookSummary, compactBookMetadata } from './lib/books.js';
import { LIBRARIES, searchUrl, recordUrl } from './lib/catalog.js';
import { rememberBook, pendingBook, forgetBook } from './lib/pending.js';
import { pasteBookDetails, isRequestPage } from './lib/paste.js';
import { compactRecord, isPreferredFormat, normalizePreferredFormat, PREFERRED_FORMAT_LABELS } from './lib/results.js';
import { isTrustedBookPage, supportedPageKind, RETAILER_LISTING, RETAILER_NOT_BOOK, RETAILER_PRODUCT, UNSUPPORTED_SITE, verifyBook, SOURCE_FAILURE } from './lib/verification.js';
import { renderCover } from './lib/cover.js';
import { loadLibraryPreferences } from './lib/preferences.js';

const $ = id => document.getElementById(id);
let libraries = [];
const views = new Map();
let candidates = [];
let activeBook = null;
let generation = 0;
let editTimer;
let detectedMetadata = {};
let sourceUrl = null;
let preferredFormat = 'print';

async function renderPending() {
  const section = $('pending-request');
  const entry = await pendingBook();
  section.replaceChildren();
  section.hidden = !entry;
  if (!entry) return;
  const library = LIBRARIES[entry.libraryId];
  section.append(node('h2', `Prepared for ${library.short}`));
  section.append(node('p', (entry.book.title || `ISBN ${entry.book.isbn}`).split(':')[0]));
  const status = node('p', '', 'copy-status');
  status.setAttribute('role', 'status');
  const actions = node('div', '', 'actions');
  actions.append(button('Paste book details', async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const latest = await pendingBook();
      if (latest?.id !== entry.id) { await renderPending(); return; }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isRequestPage(entry.libraryId, tab.url)) {
        status.textContent = `Open the ${library.short} form first.`;
        return;
      }
      const [response] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pasteBookDetails, args: [entry.libraryId, entry.book] });
      if (!response?.result?.ok) {
        status.textContent = response?.result?.message || 'The form could not be filled. The book is still in memory.';
        return;
      }
      await forgetBook(entry.id);
      await renderPending();
      $('page-status').hidden = false;
      $('page-status').textContent = 'Pasted. Book cleared.';
    } catch {
      status.textContent = 'Could not paste. Book kept for retry.';
    } finally { control.disabled = false; }
  }, 'primary'));
  actions.append(button('Copy book details', async () => {
    try { await navigator.clipboard.writeText(bookSummary(entry.book)); status.textContent = 'Copied.'; }
    catch {
      const area = node('textarea', '', 'summary');
      area.value = bookSummary(entry.book); area.readOnly = true;
      area.setAttribute('aria-label', 'Prepared book details');
      section.append(area); area.focus(); area.select();
      status.textContent = 'Press ⌘C (Mac) or Ctrl+C to copy. Choose Forget book after pasting manually.';
    }
  }));
  actions.append(link('Open form ↗', library.requestUrl));
  actions.append(button('Forget book', async () => { await forgetBook(entry.id); await renderPending(); $('page-status').hidden = false; $('page-status').textContent = 'Book cleared.'; }));
  section.append(actions, status);
}

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function button(text, handler, className = '') {
  const el = node('button', text, className);
  el.type = 'button';
  el.addEventListener('click', handler);
  return el;
}

function link(text, href, primary = false, compact = false) {
  const el = node('a', text, `button${primary ? ' primary' : ''}`);
  const url = new URL(href);
  const allowed = [...Object.values(LIBRARIES).flatMap(item => [item.origin, item.requestUrl && new URL(item.requestUrl).origin].filter(Boolean)), 'https://evgcatalog.kcls.org', 'https://www.spl.org'];
  if (!allowed.includes(url.origin)) throw new Error('Unsupported link');
  el.href = url.href;
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  if (compact) el.classList.add('text-link');
  return el;
}

function getBook() {
  const title = cleanText($('title').value);
  const author = cleanText($('author').value);
  const rawIsbn = $('isbn').value.trim();
  const isbn = normalizeIsbn(rawIsbn);
  const publisher = cleanText($('publisher').value);
  const publicationDate = cleanText($('publication-date').value, 40);
  const language = cleanText($('language').value, 80);
  if (rawIsbn && !isbn) throw new Error('Invalid ISBN. Correct it or search by title.');
  if (!title && !isbn) throw new Error('Enter a title or ISBN.');
  const requestedFormat = { print: 'Print book', ebook: 'eBook', audiobook: 'Audiobook' }[preferredFormat];
  return { ...detectedMetadata, title, author, isbn, publisher, publicationDate, language, format: requestedFormat };
}

function formBook() {
  $('form-error').hidden = true;
  try { return getBook(); }
  catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    return null;
  }
}

function fillBook(book) {
  renderCover(book.coverUrl);
  detectedMetadata = { language: book.language || '', edition: book.edition || '', audience: book.audience || '', category: book.category || '', goodreadsRating: book.goodreadsRating };
  $('title').value = book.title || '';
  $('author').value = book.author || '';
  $('isbn').value = book.isbn || '';
  $('publisher').value = book.publisher || '';
  $('publication-date').value = book.publicationDate || '';
  $('language').value = book.language || '';
  updateBookSummary();
}

function updateBookSummary() {
  $('book-summary-title').textContent = cleanText($('title').value).split(':')[0] || ($('isbn').value ? `ISBN ${$('isbn').value}` : 'Choose a book');
  $('book-summary-meta').textContent = compactBookMetadata({ author: $('author').value, publicationDate: $('publication-date').value, edition: detectedMetadata.edition, goodreadsRating: detectedMetadata.goodreadsRating });
}

function makeLibrary(library) {
  const section = node('article', '', 'library');
  section.dataset.library = library.id;
  section.setAttribute('aria-labelledby', `${library.id}-name`);
  const header = node('div', '', 'library-header');
  const title = node('div');
  const heading = node('h2', `${library.name} (${library.short})`, 'library-heading');
  heading.id = `${library.id}-name`;
  title.append(heading);
  const content = node('div', '', 'library-content');
  const elapsed = node('span', '', 'query-time');
  elapsed.setAttribute('aria-label', 'Query elapsed time');
  const libraryIcon = node('span', '', 'library-icon');
  libraryIcon.setAttribute('aria-hidden', 'true');
  const svgNS = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(svgNS, 'svg');
  for (const [name, value] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.5'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) icon.setAttribute(name, value);
  const iconPath = document.createElementNS(svgNS, 'path');
  iconPath.setAttribute('d', 'm3 8 9-5 9 5H3Zm2 3v7m5-7v7m4-7v7m5-7v7M3 21h18');
  icon.append(iconPath);
  libraryIcon.append(icon);
  const identity = node('div', '', 'library-identity'); identity.append(libraryIcon, title);
  header.append(identity, elapsed);
  section.append(header, content);
  $('libraries').append(section);
  views.set(library.id, { content, elapsed, timer: null });
}

function resetCards() {
  for (const library of libraries) {
    const view = views.get(library.id);
    clearInterval(view.timer); view.timer = null; view.elapsed.textContent = '';
    const { content } = view;
    content.replaceChildren();
    content.append(node('p', 'Ready', 'muted'));
  }
}

function showLoading(library) {
  const { content } = views.get(library.id);
  const p = node('p', '', 'loading');
  p.setAttribute('role', 'status');
  const spinner = node('span', '', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  p.append(spinner, document.createTextNode('Checking…'));
  content.replaceChildren(p);
}

function showError(library, message, book = activeBook) {
  const { content } = views.get(library.id);
  const p = node('p', message, 'error');
  p.setAttribute('role', 'status');
  content.replaceChildren(p);
  if (book) {
    const query = book.isbn || [book.title, book.author].filter(Boolean).join(' ');
    content.append(link('Catalog ↗', searchUrl(library, query)));
    content.append(button('Retry', () => searchOne(library, book, generation)));
  }
}

function renderRecord(library, record) {
  const div = node('div', '', 'result');
  const compact = compactRecord(record);
  const edition = node('div', '', 'result-edition');
  edition.append(node('span', compact.format, 'result-format'));
  if (compact.editionYear) edition.append(node('span', compact.editionYear, 'result-meta'));
  if (record.language && !/^(en|eng|english)$/i.test(record.language)) edition.append(node('span', record.language, 'result-meta'));
  const availability = node('div', '', 'result-stock');
  availability.append(node('span', compact.availability, `availability ${compact.tone}`));
  if (compact.holds) availability.append(node('span', compact.holds, 'counts'));
  const label = record.holdable ? 'Place hold ↗' : 'View book ↗';
  const action = link(label, recordUrl(library, record.id), false, true);
  action.classList.add('hold-action');
  action.title = [record.title, compact.format, compact.editionYear].filter(Boolean).join(' · ');
  div.append(edition, availability, action);
  return div;
}

function requestSection(library, book) {
  const section = node('div', '', 'request');
  const status = node('p', '', 'copy-status'); status.setAttribute('role', 'status');
  const action = button('Request purchase', async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const entry = await rememberBook(library.id, { ...book, audience: book.audience || 'Adults' });
      const response = await chrome.runtime.sendMessage({ type: 'OPEN_REQUEST', entryId: entry.id });
      if (!response?.ok) throw new Error(response?.message || 'Could not open form.');
      status.textContent = '';
    } catch (error) { status.textContent = error.message || 'Could not open form.'; }
    finally { control.disabled = false; }
  }, 'primary');
  const arrow = node('span', '↗', 'action-icon'); arrow.setAttribute('aria-hidden', 'true'); action.append(arrow);
  section.append(action, status);
  return section;
}

function renderResults(library, book, result) {
  const { content } = views.get(library.id);
  content.replaceChildren();
  const matched = [...result.print, ...result.otherFormats].filter(record => record.match.strong);
  const preferredRecords = matched.filter(record => isPreferredFormat(record.format, preferredFormat));
  const otherFormats = matched.filter(record => !isPreferredFormat(record.format, preferredFormat));
  if (result.noResults) {
    const empty = node('div', '', 'empty-result');
    empty.append(node('span', 'No matching book.'), link('Catalog ↗', result.searchUrl, false, true));
    content.append(empty);
  } else if (preferredRecords.length) {
    for (const record of preferredRecords.slice(0, 5)) content.append(renderRecord(library, record));
  } else if (otherFormats.length) {
    content.append(node('p', `No ${PREFERRED_FORMAT_LABELS[preferredFormat]} match.`));
  } else if (!otherFormats.length) {
    content.append(node('p', 'No confirmed match. Check the catalog.'));
  }
  if (otherFormats.length) {
    const details = node('details', '', 'alternates');
    details.append(node('summary', `Other formats (${otherFormats.length})`));
    for (const record of otherFormats.slice(0, 5)) details.append(renderRecord(library, record));
    content.append(details);
  }
  if (!result.complete || preferredRecords.length > 5 || otherFormats.length > 5) content.append(node('p', 'More results in catalog', 'checked'));
  const footer = node('div', '', 'library-footer');
  if (!result.noResults) footer.append(link('Catalog ↗', result.searchUrl, false, true));
  if (result.noResults && library.supportsPurchase) footer.append(requestSection(library, book));
  else if (result.noResults && library.purchaseLinkOnly) footer.append(link('Suggest a purchase ↗', library.requestUrl, false, true));
  if (footer.childNodes.length) content.append(footer);
}

async function searchOne(library, book, token) {
  showLoading(library);
  const view = views.get(library.id);
  clearInterval(view.timer);
  const started = performance.now();
  const update = () => { view.elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`; };
  update(); view.timer = setInterval(update, 100);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LOOKUP', libraryId: library.id, book });
    if (token !== generation) return;
    if (!response?.ok) throw new Error(response?.message || 'Could not check catalog.');
    renderResults(library, book, response.result);
    if (response.cached) { update(); view.elapsed.textContent += ' · cached'; }
    else view.elapsed.textContent = `${(response.elapsedMs / 1000).toFixed(1)}s`;
  } catch (error) {
    if (token === generation) { showError(library, error.message || 'Could not check this library.', book); update(); }
  } finally {
    if (token === generation) { clearInterval(view.timer); view.timer = null; }
  }
}

async function searchLibraries() {
  let book = formBook();
  if (!book) return;
  if (sourceUrl && !isTrustedBookPage(sourceUrl)) {
    const verificationToken = generation;
    $('book-form').hidden = true; $('libraries').hidden = true;
    $('page-status').hidden = false; $('page-status').textContent = 'Checking book details…';
    try { const goodreadsRating = book.goodreadsRating; book = { ...await verifyBook(book, { libraryIds: libraries.map(library => library.id), isCurrent: () => verificationToken === generation }), goodreadsRating, format: { print: 'Print book', ebook: 'eBook', audiobook: 'Audiobook' }[preferredFormat] }; }
    catch {
      if (verificationToken !== generation) return;
      $('page-status').textContent = SOURCE_FAILURE;
      $('candidate-section').hidden = true; $('pending-request').hidden = true;
      return;
    }
    if (verificationToken !== generation) return;
    fillBook(book);
    $('book-form').hidden = false; $('libraries').hidden = false;
  }
  clearTimeout(editTimer);
  activeBook = book;
  $('page-status').hidden = false;
  $('page-status').textContent = 'Checking libraries…';
  updateBookSummary();
  $('book-details').open = false;
  $('book-form').hidden = false; $('libraries').hidden = false;
  const token = ++generation;
  resetCards();
  await Promise.allSettled(libraries.map(library => searchOne(library, book, token)));
  if (token === generation) $('page-status').hidden = true;
}

function edited(event) {
  if (['title', 'isbn'].includes(event?.target?.id)) renderCover('');
  generation++;
  activeBook = null;
  $('form-error').hidden = true;
  updateBookSummary();
  resetCards();
  clearTimeout(editTimer);
  if ($('title').value.trim() || $('isbn').value.trim()) editTimer = setTimeout(searchLibraries, 700);
}

async function readPage() {
  const readToken = ++generation;
  sourceUrl = null;
  try {
    $('candidate-section').hidden = true;
    $('candidates').replaceChildren();
    $('book-form').hidden = true;
    $('libraries').hidden = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (readToken !== generation) return;
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('restricted');
    const entry = await pendingBook();
    if (readToken !== generation) return;
    if (libraries.some(library => isRequestPage(library.id, tab.url))) {
      $('book-form').hidden = true;
      $('libraries').hidden = true;
      $('page-status').hidden = Boolean(entry);
      $('page-status').textContent = entry ? '' : 'No book prepared.';
      return;
    }
    sourceUrl = tab.url;
    const pageKind = supportedPageKind(sourceUrl);
    if (pageKind === 'unsupported') {
      $('page-status').textContent = UNSUPPORTED_SITE;
      $('book-form').hidden = true; $('libraries').hidden = true; $('pending-request').hidden = true;
      return;
    }
    if (pageKind !== 'product') {
      $('page-status').textContent = pageKind === 'listing' ? RETAILER_LISTING : RETAILER_PRODUCT;
      $('book-form').hidden = true; $('libraries').hidden = true; $('pending-request').hidden = true;
      return;
    }
    $('page-status').textContent = 'Reading book details…';
    const data = await readBookPage(tab.id, { isCurrent: () => readToken === generation });
    if (readToken !== generation) return;
    candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    if (!isTrustedBookPage(sourceUrl)) candidates = candidates.map(({ coverUrl, ...book }) => book);
    if (!candidates.length) {
      $('page-status').textContent = RETAILER_NOT_BOOK;
      $('book-form').hidden = true; $('libraries').hidden = true; $('pending-request').hidden = true;
      return;
    }
    if (candidates.length > 1) {
      $('candidate-section').hidden = false;
      const placeholder = node('option', 'Choose a book from this page…');
      placeholder.value = '';
      $('candidates').append(placeholder);
      for (const [index, book] of candidates.entries()) {
        const option = node('option', book.title ? `${book.title}${book.author ? ` — ${book.author}` : ''}` : `ISBN ${book.isbn}`);
        option.value = String(index);
        $('candidates').append(option);
      }
      $('page-status').textContent = `${candidates.length} books found.`;
      return;
    }
    fillBook(candidates[0]);
    await searchLibraries();
  } catch {
    if (readToken !== generation) return;
    $('page-status').textContent = sourceUrl ? RETAILER_NOT_BOOK : 'Enter a title or ISBN.';
    if (sourceUrl) { $('book-form').hidden = true; $('libraries').hidden = true; }
    else { $('book-form').hidden = false; $('book-details').open = true; }
  }
}

async function refreshPage() {
  const control = $('refresh-button');
  control.disabled = true;
  clearTimeout(editTimer);
  generation++;
  activeBook = null;
  candidates = [];
  detectedMetadata = {};
  $('candidate-section').hidden = true;
  $('candidates').replaceChildren();
  $('book-form').hidden = true;
  $('libraries').hidden = true;
  $('page-status').hidden = false;
  $('page-status').textContent = 'Refreshing page details and library results…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHES' });
    if (!response?.ok) throw new Error(response?.message || 'Could not clear the temporary cache.');
    if ($('title')) { $('title').value = ''; $('author').value = ''; $('isbn').value = ''; $('publisher').value = ''; $('publication-date').value = ''; $('language').value = ''; }
    renderCover('');
    await readPage();
  } catch {
    $('page-status').textContent = 'Refresh failed. Close and reopen the extension to try again.';
  } finally { control.disabled = false; }
}

async function init() {
  const openSettings = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  $('settings-button').addEventListener('click', openSettings);
  $('refresh-button').addEventListener('click', refreshPage);
  $('setup-button').addEventListener('click', openSettings);
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const libraryPreferences = await loadLibraryPreferences(chrome.storage.local);
  preferredFormat = normalizePreferredFormat(libraryPreferences?.preferredFormat);
  const selectedIds = Array.isArray(libraryPreferences?.selectedIds) ? libraryPreferences.selectedIds : [];
  if (selectedIds.length >= 1 && selectedIds.length <= 3 && selectedIds.every(id => Object.hasOwn(LIBRARIES, id))) {
    libraries = selectedIds.map(id => LIBRARIES[id]);
    $('setup-prompt').hidden = true;
  } else {
    $('setup-prompt').hidden = false;
    $('page-status').hidden = true;
    $('book-form').hidden = true;
    $('libraries').hidden = true;
    $('refresh-button').hidden = true;
    return;
  }
  for (const library of libraries) makeLibrary(library);
  $('book-form').addEventListener('submit', event => { event.preventDefault(); searchLibraries(); });
  $('book-form').addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); searchLibraries(); } });
  for (const id of ['title', 'author', 'isbn', 'publisher', 'publication-date', 'language']) $(id).addEventListener('input', edited);
  $('candidates').addEventListener('change', () => {
    edited();
    const value = $('candidates').value;
    fillBook(value === '' ? {} : candidates[Number(value)] || {});
    clearTimeout(editTimer);
    if (value !== '') searchLibraries();
  });
  resetCards();
  await renderPending();
  if (!libraries.length) return;
  await readPage();
}

init().catch(() => {
  $('page-status').textContent = 'Library Lens could not start. Close and reopen the extension to try again.';
});
