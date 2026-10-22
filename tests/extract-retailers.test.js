import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBookCandidates } from '../extension/lib/extract.js';

function visibleText(value, extra = {}) {
  return {
    innerText: value,
    textContent: value,
    getClientRects: () => [{ width: 1, height: 1 }],
    closest: () => null,
    getAttribute: () => null,
    ...extra
  };
}

function runExtraction(url, { title, author, jsonLd, ratingLabel, queriedSelectors } = {}) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const h1 = title ? visibleText(title) : null;
  const authorNode = author ? visibleText(author) : null;
  const jsonLdNode = jsonLd ? { textContent: JSON.stringify(jsonLd) } : null;
  const ratingNode = ratingLabel ? visibleText('', { getAttribute: name => name === 'aria-label' ? ratingLabel : null }) : null;
  globalThis.location = new URL(url);
  globalThis.document = {
    title: title || '',
    querySelector(selector) {
      if (selector.includes('#productTitle') && title) return h1;
      return null;
    },
    querySelectorAll(selector) {
      queriedSelectors?.push(selector);
      if (selector === 'h1') return h1 ? [h1] : [];
      if (selector === 'script[type="application/ld+json"]') return jsonLdNode ? [jsonLdNode] : [];
      if (selector === '[aria-label*="Average rating"]') return ratingNode ? [ratingNode] : [];
      if (selector.includes('[itemprop="author"]')) return authorNode ? [authorNode] : [];
      return [];
    }
  };
  try { return extractBookCandidates(); }
  finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
}

test('Goodreads extracts book details and a validated rating from its Book metadata', () => {
  const queriedSelectors = [];
  const result = runExtraction('https://www.goodreads.com/book/show/249060851-vibe', {
    queriedSelectors,
    title: 'Vibe: The Secrets of Strong Connections in a Lonely World',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Book', name: 'Vibe: The Secrets of Strong Connections in a Lonely World', isbn: '9798217059706', author: { '@type': 'Person', name: 'Adam M. Grant' }, datePublished: '2026-10-15', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.25', ratingCount: '34' } }
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, 'Vibe: The Secrets of Strong Connections in a Lonely World');
  assert.equal(result.candidates[0].author, 'Adam M. Grant');
  assert.equal(result.candidates[0].isbn, '9798217059706');
  assert.deepEqual(result.candidates[0].goodreadsRating, { value: 4.25, count: 34 });
  assert.equal(queriedSelectors.includes('p, li, td, dd'), false);
});

test('Goodreads reads visible rating text when structured rating metadata is absent', () => {
  const result = runExtraction('https://www.goodreads.com/book/show/22034.The_Godfather', {
    title: 'The Godfather',
    jsonLd: { '@type': 'Book', name: 'The Godfather', isbn: '9780451205766', author: { '@type': 'Person', name: 'Mario Puzo' } },
    ratingLabel: 'Average rating of 4.40 stars. 481,045 ratings and 16,616 reviews'
  });
  assert.deepEqual(result.candidates[0].goodreadsRating, { value: 4.4, count: 481045 });
  const invalid = runExtraction('https://www.goodreads.com/book/show/22034.The_Godfather', {
    title: 'The Godfather',
    jsonLd: { '@type': 'Book', name: 'The Godfather', isbn: '9780451205766', author: { '@type': 'Person', name: 'Mario Puzo' }, aggregateRating: { ratingValue: '99', ratingCount: '99999999999999999999' } }
  });
  assert.equal(invalid.candidates[0].goodreadsRating, undefined);
});

test('Barnes & Noble extracts product details from book metadata', () => {
  const result = runExtraction('https://www.barnesandnoble.com/w/vibe-adam-grant/1234567890', {
    title: 'Vibe',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Book', name: 'Vibe', isbn: '9798217059706', author: { '@type': 'Person', name: 'Adam Grant' } }
  });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    Object.fromEntries(['title', 'author', 'isbn'].map(key => [key, result.candidates[0][key]])),
    { title: 'Vibe', author: 'Adam Grant', isbn: '9798217059706' }
  );
});

test('duplicate ISBN metadata fills a missing author without overwriting known details', () => {
  const result = runExtraction('https://www.barnesandnoble.com/w/vibe-adam-grant/1234567890', {
    title: 'Vibe',
    jsonLd: [
      { '@type': 'Book', name: 'Vibe', isbn: '9798217059706' },
      { '@type': 'Book', name: 'Vibe', isbn: '9798217059706', author: { name: 'Adam Grant' } },
      { '@type': 'Book', name: 'Different title', isbn: '9798217059706', author: { name: 'Different author' } }
    ]
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, 'Vibe');
  assert.equal(result.candidates[0].author, 'Adam Grant');
});
