import { cleanText, normalizeIsbn, purchaseMetadata } from './books.js';

const KEY = 'pendingPurchaseBook';
const LIFETIME = 60 * 60 * 1000;

export async function rememberBook(libraryId, book, storage = chrome.storage.session) {
  if (!['kcls', 'spl'].includes(libraryId)) throw new Error('Unknown library');
  const title = cleanText(book.title);
  const author = cleanText(book.author);
  const isbn = normalizeIsbn(book.isbn);
  if (!title && !isbn) throw new Error('No book details to remember.');
  // One slot: preparing another request replaces the previous book.
  const entry = { id: crypto.randomUUID(), libraryId, book: { title, author, isbn, ...purchaseMetadata(book) }, savedAt: Date.now() };
  await storage.set({ [KEY]: entry });
  return entry;
}

export async function pendingBook(storage = chrome.storage.session) {
  const entry = (await storage.get(KEY))[KEY];
  if (!entry) return null;
  if (!['kcls', 'spl'].includes(entry.libraryId) || typeof entry.id !== 'string' ||
      !Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > LIFETIME || entry.savedAt > Date.now() + 60000 ||
      !entry.book || (!cleanText(entry.book.title) && !normalizeIsbn(entry.book.isbn))) {
    await storage.remove(KEY);
    return null;
  }
  return entry;
}

export async function forgetBook(id, storage = chrome.storage.session) {
  const entry = (await storage.get(KEY))[KEY];
  if (entry?.id === id) await storage.remove(KEY);
}
