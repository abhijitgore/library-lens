import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLibraryPreferences, sanitizeLibraryPreferences } from '../extension/lib/preferences.js';

test('persistent preferences discard ZIP and unknown personal fields', () => {
  assert.deepEqual(sanitizeLibraryPreferences({
    zip: '94129', name: 'Example', email: 'person@example.test', selectedIds: ['sfpl', 'sfpl', 'marin', 'uw', 'unknown'], preferredFormat: 'ebook'
  }), { selectedIds: ['sfpl', 'marin', 'uw'], preferredFormat: 'ebook' });
});

test('persistent preferences apply safe defaults and reject non-string library IDs', () => {
  assert.deepEqual(sanitizeLibraryPreferences({ selectedIds: [null, {}, 'kcls'], preferredFormat: 'unknown' }), { selectedIds: ['kcls'], preferredFormat: 'print' });
});

test('loading migrates legacy ZIP data out of persistent storage', async () => {
  const state = { libraryPreferences: { zip: '94129', selectedIds: ['sfpl'], preferredFormat: 'ebook' } };
  const storage = {
    async get(key) { return { [key]: state[key] }; },
    async set(values) { Object.assign(state, values); }
  };
  assert.deepEqual(await loadLibraryPreferences(storage), { selectedIds: ['sfpl'], preferredFormat: 'ebook' });
  assert.deepEqual(state, { libraryPreferences: { selectedIds: ['sfpl'], preferredFormat: 'ebook' } });
});
