import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRecord, isPreferredFormat, normalizePreferredFormat } from '../extension/lib/results.js';

const record = { format: 'BK', edition: 'Third edition.', year: '2014', availability: { status: 'AVAILABLE', availableCopies: 43, totalCopies: 70, heldCopies: 4 } };
test('compact record exposes edition and actionable counts without repeated book identity', () => {
  assert.deepEqual(compactRecord(record), { format: 'Print', editionYear: '3rd ed. / 2014', availability: '43/70 available', holds: '4 holds', tone: 'available' });
  const unavailable = compactRecord({ ...record, availability: { ...record.availability, status: 'UNAVAILABLE', availableCopies: 0, heldCopies: 1 } });
  assert.equal(unavailable.availability, '0/70 available');
  assert.equal(unavailable.holds, '1 hold');
  assert.equal(unavailable.tone, 'waiting');
});
test('compact counts never override reference-only, on-order or unknown borrowing status', () => {
  assert.equal(compactRecord({ ...record, availability: { ...record.availability, libraryUseOnly: true } }).availability, 'Library use only');
  assert.equal(compactRecord({ ...record, availability: { status: 'UNAVAILABLE', totalCopies: 0, availableCopies: 0, onOrderCopies: 3 } }).availability, 'On order');
  assert.deepEqual(compactRecord({ ...record, availability: { status: 'UNKNOWN', localisedStatus: 'ON_ORDER', totalCopies: 189, availableCopies: 0, onOrderCopies: 164, heldCopies: 24 } }), { format: 'Print', editionYear: '3rd ed. / 2014', availability: 'On order', holds: '24 holds', tone: 'neutral' });
  assert.equal(compactRecord({ ...record, availability: null }).availability, 'Availability unknown — check catalog');
  assert.equal(compactRecord({ ...record, edition: '', year: '', availability: null }).editionYear, '');
  assert.equal(compactRecord({ ...record, availability: null }).holds, '');
});

test('preferred formats group print, ebook and audiobook catalog records safely', () => {
  assert.equal(isPreferredFormat('BK', 'print'), true);
  assert.equal(isPreferredFormat('LPRINT', 'print'), true);
  assert.equal(isPreferredFormat('EBOOK', 'ebook'), true);
  for (const format of ['AB', 'AB_CD', 'EAB']) assert.equal(isPreferredFormat(format, 'audiobook'), true);
  assert.equal(isPreferredFormat('EBOOK', 'audiobook'), false);
  assert.equal(normalizePreferredFormat('invalid'), 'print');
  assert.equal(compactRecord({ format: 'AB' }).format, 'Audiobook');
});
