import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIsbn, isbn13, matchBook, bookSummary, compactPublicationDate, compactEdition, compactBookMetadata } from '../extension/lib/books.js';

test('ISBN checksums and ISBN-10/13 equivalence', () => {
  assert.equal(normalizeIsbn('ISBN-13: 978-0-593-13520-4'), '9780593135204');
  assert.equal(normalizeIsbn('0593135202'), '0593135202');
  assert.equal(isbn13('0593135202'), '9780593135204');
  assert.equal(normalizeIsbn('9780593135205'), '');
  assert.equal(normalizeIsbn('0593135203'), '');
  assert.equal(normalizeIsbn('1234567890128'), '');
  assert.equal(normalizeIsbn('0-8044-2957-X'), '080442957X');
});

test('matching tolerates inverted authors and subtitle differences, but not wrong authors', () => {
  const book = { title: 'Project Hail Mary: A Novel', author: 'Andy Weir', isbn: '' };
  const record = { title: 'Project Hail Mary', authors: ['Weir, Andy'], isbns: [] };
  assert.equal(matchBook(book, record).strong, true);
  assert.equal(matchBook(book, { ...record, authors: ['Other, Someone'] }).possible, false);
  assert.equal(matchBook({ ...book, author: '' }, record).strong, false);
  assert.equal(matchBook({ ...book, isbn: '0593135202' }, { ...record, isbns: ['9780593135204'] }).exactIsbn, true);
});

test('request summary includes book fields only', () => {
  const text = bookSummary({ title: 'A Book', author: 'An Author', isbn: '9780593135204', sourceUrl: 'https://private.example/path' });
  assert.match(text, /Title: A Book/);
  assert.match(text, /Requested format: Print book/);
  assert.doesNotMatch(text, /private\.example/);
});

test('compact book heading formats publication date and edition beside the author', () => {
  assert.equal(compactPublicationDate('2026-09-21'), 'Sep 2026');
  assert.equal(compactPublicationDate('June 21, 2022'), 'Jun 2022');
  assert.equal(compactPublicationDate('2022'), '2022');
  assert.equal(compactPublicationDate('unknown'), '');
  assert.equal(compactEdition('3rd edition'), '3rd ed.');
  assert.equal(compactEdition('Third Edition'), '3rd ed.');
  assert.equal(compactEdition('1st ed.'), '1st ed.');
  assert.equal(compactBookMetadata({ author: 'Chip Huyen', publicationDate: 'September 2026', edition: '3rd edition' }), 'Chip Huyen · Sep 2026 · 3rd ed.');
  assert.equal(compactBookMetadata({ author: 'Chip Huyen' }), 'Chip Huyen');
  assert.equal(compactBookMetadata({ publicationDate: '2026-09-21', edition: '3rd edition' }), 'Sep 2026 · 3rd ed.');
});

test('compact book heading includes only a bounded Goodreads rating summary', () => {
  assert.equal(compactBookMetadata({ author: 'Adam Grant', goodreadsRating: { value: 4.25, count: 34 } }), 'Adam Grant · 4.25 stars from 34 ratings');
  assert.equal(compactBookMetadata({ author: 'Adam Grant', goodreadsRating: { value: 50, count: 34 } }), 'Adam Grant');
});
