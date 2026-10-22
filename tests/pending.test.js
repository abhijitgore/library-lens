import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberBook, pendingBook, forgetBook } from '../extension/lib/pending.js';
import { isRequestPage } from '../extension/lib/paste.js';

function memoryStorage() {
  const data = {};
  return { get: async key => ({ [key]: data[key] }), set: async values => Object.assign(data, values), remove: async key => { delete data[key]; }, data };
}

test('one book replaces the previous one and only known book fields are retained', async () => {
  const storage = memoryStorage();
  const first = await rememberBook('kcls', { title: 'First book', cardNumber: 'not-stored', url: 'https://private.example' }, storage);
  const second = await rememberBook('spl', { title: 'Second book', author: 'Author', isbn: '9780593135204' }, storage);
  assert.equal(Object.keys(storage.data).length, 1);
  assert.deepEqual((await pendingBook(storage)).book, { title: 'Second book', author: 'Author', isbn: '9780593135204' });
  await forgetBook(first.id, storage);
  assert.equal((await pendingBook(storage)).id, second.id);
  await forgetBook(second.id, storage);
  assert.equal(await pendingBook(storage), null);
  assert.doesNotMatch(JSON.stringify(storage.data), /not-stored|private.example/);
});

test('expired books are discarded', async () => {
  const storage = memoryStorage();
  const entry = await rememberBook('spl', { title: 'Expired book' }, storage);
  entry.savedAt = Date.now() - 61 * 60 * 1000;
  assert.equal(await pendingBook(storage), null);
  assert.equal(Object.keys(storage.data).length, 0);
});

test('purchase metadata survives popup handoff without retaining unrelated page data', async () => {
  const storage = memoryStorage();
  await rememberBook('kcls', { title: 'Building AI Agents for Finance', isbn: '1837022291', publisher: 'Example Publisher', publicationDate: '2025-06-06', language: 'English', audience: 'Adults', format: 'Print book', pageText: 'not retained' }, storage);
  const entry = await pendingBook(storage);
  assert.equal(entry.book.publisher, 'Example Publisher');
  assert.equal(entry.book.publicationDate, '2025-06-06');
  assert.equal(entry.book.language, 'English');
  assert.equal(entry.book.audience, 'Adults');
  assert.equal(entry.book.pageText, undefined);
});

test('paste is restricted to exact official request origins and paths', () => {
  assert.equal(isRequestPage('spl', 'https://www.spl.org/books-and-media/suggest-a-title'), true);
  assert.equal(isRequestPage('kcls', 'https://evgcatalog.kcls.org/patron-ui/en/requests/create'), true);
  assert.equal(isRequestPage('spl', 'https://www.spl.org.evil.example/books-and-media/suggest-a-title'), false);
  assert.equal(isRequestPage('spl', 'https://www.spl.org/other-form'), false);
  assert.equal(isRequestPage('kcls', 'https://seattle.bibliocommons.com/user/login'), false);
});
