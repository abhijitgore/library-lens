import { extractBookCandidates } from './extract.js';

// Only called after the user opens the extension on an allowed book URL.
// Retry incomplete hydration briefly; install no persistent page observer.
export async function readBookPage(tabId, { execute = options => chrome.scripting.executeScript(options), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), isCurrent = () => true } = {}) {
  let data;
  for (const delay of [0, 250, 750]) {
    if (delay) await wait(delay);
    if (!isCurrent()) return null;
    const [response] = await execute({ target: { tabId }, func: extractBookCandidates });
    if (!isCurrent()) return null;
    data = response?.result;
    if (data?.candidates?.some(book => book.title && book.author)) return data;
  }
  return data;
}
