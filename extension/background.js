import { fetchLocXml } from './lib/verification.js';
import { LIBRARIES } from './lib/catalog.js';
import { pendingBook, forgetBook } from './lib/pending.js';
import { pasteBookDetails, isRequestPage } from './lib/paste.js';
import { installRequestHelper } from './lib/floating.js';
import { createLookupCoordinator } from './lib/lookups.js';

// The worker coordinates all network requests and request-tab actions. It only
// injects the purchase helper into the exact library form tab opened by us.
chrome.runtime.onInstalled?.addListener(details => {
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') }).catch(() => {});
});

const lookup = createLookupCoordinator({ storage: chrome.storage.session });
const popupUrl = chrome.runtime.getURL('popup.html');

async function attach(tabId) {
  const entry = await pendingBook();
  if (!entry || entry.tabId !== tabId) return;
  const tab = await chrome.tabs.get(tabId);
  if (!isRequestPage(entry.libraryId, tab.url)) return;
  await chrome.scripting.executeScript({ target: { tabId }, func: installRequestHelper, args: [entry.id, entry.libraryId] });
}

async function fillRequest(entryId, tabId) {
  const entry = await pendingBook();
  if (!entry || entry.id !== entryId) return { ok: false, message: 'No prepared book. Start a new request.' };
  const tab = await chrome.tabs.get(tabId);
  if (!isRequestPage(entry.libraryId, tab.url)) return { ok: false, message: 'Open the request form first.' };
  if (entry.tabId !== tabId) return { ok: false, message: 'Use the request tab opened by Library Lens.' };
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: pasteBookDetails, args: [entry.libraryId, entry.book] });
  const result = injection?.result || { ok: false, message: 'Could not fill. Book kept for retry.' };
  if (result.ok) { await forgetBook(entry.id); await lookup.clearCache(); }
  return result;
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Unsupported sender');
  const fromPopup = sender.url === popupUrl;
  if (message?.type === 'VERIFY_BOOK' && fromPopup) return { ok: true, xml: await fetchLocXml(message.isbn) };
  if (message?.type === 'LOOKUP' && fromPopup) return { ok: true, ...await lookup(message.libraryId, message.book) };
  if (message?.type === 'CLEAR_CACHES' && fromPopup) {
    await lookup.clearCache();
    await chrome.storage.session.remove('verifiedSourceBook');
    return { ok: true };
  }
  if (message?.type === 'OPEN_REQUEST' && fromPopup) {
    const entry = await pendingBook();
    if (!entry || entry.id !== message.entryId) throw new Error('No prepared book');
    const old = entry.tabId;
    if (Number.isInteger(old)) chrome.tabs.sendMessage(old, { type: 'REMOVE_HELPER' }).catch(() => {});
    const tab = await chrome.tabs.create({ url: LIBRARIES[entry.libraryId].requestUrl });
    // Opening a tab yields to other popup actions. Never resurrect a book
    // that was replaced or forgotten while Chrome was opening the form.
    const current = await pendingBook();
    if (current?.id !== entry.id) throw new Error('Prepared book changed. Start the request again.');
    await chrome.storage.session.set({ pendingPurchaseBook: { ...entry, tabId: tab.id } });
    attach(tab.id).catch(() => {});
    return { ok: true, tabId: tab.id };
  }
  if (message?.type === 'FILL_REQUEST' && sender.tab && sender.frameId === 0 && Object.keys(LIBRARIES).some(id => isRequestPage(id, sender.url))) {
    return fillRequest(message.entryId, sender.tab.id);
  }
  throw new Error('Unsupported action');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, error => respond({ ok: false, message: error.message || 'Could not complete this action.' }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete' || change.url) attach(tabId).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  pendingBook().then(entry => { if (entry?.tabId === tabId) return forgetBook(entry.id); }).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.pendingPurchaseBook) return;
  const { oldValue, newValue } = changes.pendingPurchaseBook;
  if (oldValue && !newValue) { lookup.clearCache().catch(() => {}); chrome.storage.session.remove('verifiedSourceBook').catch(() => {}); }
  if (oldValue?.id !== newValue?.id && Number.isInteger(oldValue?.tabId)) {
    chrome.tabs.sendMessage(oldValue.tabId, { type: 'REMOVE_HELPER' }).catch(() => {});
  }
});
