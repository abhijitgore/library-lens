import { cleanText, normalizeIsbn } from './books.js';
import { lookupLibrary, LIBRARIES } from './catalog.js';

// Share concurrent catalog requests and retain only the latest book's results
// for ten minutes in session storage.
export function createLookupCoordinator({ storage, lookup = lookupLibrary, now = Date.now } = {}) {
  const inflight = new Map();
  let currentKey = '';
  let writes = Promise.resolve();
  let epoch = 0;
  const run = async (libraryId, input) => {
    if (typeof libraryId !== 'string' || !Object.hasOwn(LIBRARIES, libraryId)) throw new Error('Unknown library');
    const book = { title: cleanText(input?.title), author: cleanText(input?.author), isbn: normalizeIsbn(input?.isbn) };
    if (!book.title && !book.isbn) throw new Error('Enter a title or ISBN.');
    const key = JSON.stringify(book);
    const requestEpoch = epoch;
    currentKey = key;
    const cache = (await storage.get('latestLookup')).latestLookup;
    const cached = cache?.key === key ? cache.results?.[libraryId] : null;
    if (requestEpoch === epoch && cached && now() - cached.savedAt >= 0 && now() - cached.savedAt < 600000) return { ...cached.response, cached: true };
    const operation = `${requestEpoch}:${libraryId}:${key}`;
    if (inflight.has(operation)) return inflight.get(operation);
    const job = (async () => {
      const startedEpoch = requestEpoch;
      const start = now();
      const result = await lookup(libraryId, book);
      const response = { result, elapsedMs: now() - start, cached: false };
      writes = writes.catch(() => {}).then(async () => {
        if (currentKey !== key || epoch !== startedEpoch) return;
        const existing = (await storage.get('latestLookup')).latestLookup;
        const results = existing?.key === key ? existing.results : {};
        await storage.set({ latestLookup: { key, results: { ...results, [libraryId]: { response, savedAt: now() } } } });
      });
      await writes;
      return response;
    })();
    inflight.set(operation, job);
    try { return await job; }
    finally { inflight.delete(operation); }
  };
  run.clearCache = async () => {
    epoch++;
    currentKey = '';
    await writes.catch(() => {});
    await storage.remove('latestLookup');
  };
  return run;
}
