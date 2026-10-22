import test from 'node:test';
import assert from 'node:assert/strict';
import { readBookPage } from '../extension/lib/read-page.js';

test('clicked-page extraction retries delayed title/byline hydration and stops as soon as ready', async () => {
  const delays = [], seen = [];
  const replies = [{ candidates: [] }, { candidates: [{ title: 'Book' }] }, { candidates: [{ title: 'Book', author: 'Author' }] }];
  const result = await readBookPage(7, { wait: async ms => delays.push(ms), execute: async options => { seen.push(options.target.tabId); return [{ result: replies.shift() }]; } });
  assert.equal(result.candidates[0].author, 'Author');
  assert.deepEqual(delays, [250, 750]);
  assert.deepEqual(seen, [7, 7, 7]);
});

test('ready book details avoid retries regardless of format; stale refresh stops page reads', async () => {
  for (const data of [{ candidates: [{ title: 'Book', author: 'Author' }] }, { audioEdition: true, candidates: [{ title: 'Audio Book', author: 'Author' }] }]) {
    let reads = 0;
    await readBookPage(7, { execute: async () => { reads++; return [{ result: data }]; }, wait: async () => assert.fail('ready page must not wait') });
    assert.equal(reads, 1);
  }
  let current = true, reads = 0;
  const result = await readBookPage(7, { isCurrent: () => current, execute: async () => { reads++; return [{ result: { candidates: [] } }]; }, wait: async () => { current = false; } });
  assert.equal(result, null);
  assert.equal(reads, 1);
});

test('audio format detection does not stop retries before book details arrive', async () => {
  let reads = 0;
  const result = await readBookPage(7, { wait: async () => {}, execute: async () => [{ result: ++reads === 1 ? { audioEdition: true, candidates: [] } : { audioEdition: true, candidates: [{ title: 'Audio Book', author: 'Author' }] } }] });
  assert.equal(reads, 2);
  assert.equal(result.candidates[0].author, 'Author');
});
