import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LIBRARIES } from '../extension/lib/catalog.js';
import { findLibrariesNearZip, formatDistance } from '../extension/lib/directory.js';

const directory = JSON.parse(await readFile(new URL('../extension/data/library-locations.json', import.meta.url), 'utf8'));

test('ZIP lookup ranks supported systems by the nearest reported branch without a network request', () => {
  const nearby = findLibrariesNearZip('94129', directory, Object.values(LIBRARIES));
  assert.deepEqual(nearby.slice(0, 4).map(library => library.id), ['sfpl', 'marin', 'smcl', 'oakland']);
  assert.ok(nearby[0].distanceMiles < 2);
  assert.equal(nearby.length, 8);
  assert.equal(formatDistance(nearby[0].distanceMiles), '1.1 mi');
});

test('98052 includes nearby systems and UW as an academic library catalog', () => {
  const nearby = findLibrariesNearZip('98052', directory, Object.values(LIBRARIES))
    .filter(library => library.distanceMiles != null && library.distanceMiles <= 75);
  assert.deepEqual(nearby.map(library => library.id), ['kcls', 'spl', 'uw']);
});

test('95129 finds San José Public Library from its reported nearby branches', () => {
  const nearby = findLibrariesNearZip('95129', directory, Object.values(LIBRARIES))
    .filter(library => library.distanceMiles != null && library.distanceMiles <= 75);
  assert.equal(nearby[0].id, 'sjpl');
  assert.ok(nearby[0].distanceMiles < 5);
});

test('ZIP lookup rejects malformed and unmapped codes', () => {
  assert.throws(() => findLibrariesNearZip('9412', directory, Object.values(LIBRARIES)), /5-digit/);
  assert.throws(() => findLibrariesNearZip('00000', directory, Object.values(LIBRARIES)), /could not map/);
});

test('ZIP directory only contains approved supported systems and bounded coordinate data', () => {
  assert.deepEqual(Object.keys(directory.systems).sort(), Object.keys(LIBRARIES).sort());
  assert.ok(directory.zipCentroids['94129'].every(Number.isFinite));
  for (const system of Object.values(directory.systems)) {
    assert.ok(system.outlets.length > 0);
    assert.ok(system.outlets.every(outlet => Number.isFinite(outlet.lat) && Number.isFinite(outlet.lon)));
  }
});
