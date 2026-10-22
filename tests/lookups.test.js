import test from 'node:test';
import assert from 'node:assert/strict';
import { createLookupCoordinator } from '../extension/lib/lookups.js';

const book = { title: 'Project Hail Mary', author: 'Andy Weir', isbn: '9780593135204' };
function setup(lookup) {
  const state = {};
  let time = 1000;
  const storage = {
    async get(key) { return structuredClone({ [key]: state[key] }); },
    async set(value) { Object.assign(state, structuredClone(value)); },
    async remove(key) { delete state[key]; }
  };
  return { state, advance(ms) { time += ms; }, run: createLookupCoordinator({ storage, lookup, now: () => time }) };
}

test('concurrent identical requests share one operation', async () => {
  let calls = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { run } = setup(async () => { calls++; await gate; return { noResults: true }; });
  const first = run('kcls', book);
  const second = run('kcls', { ...book });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await first, await second);
  assert.equal((await run('kcls', book)).cached, true);
  assert.equal(calls, 1);
});

test('concurrent library results merge into one book cache', async () => {
  let calls = 0;
  const { run, state } = setup(async library => { calls++; return { library }; });
  await Promise.all([run('kcls', book), run('spl', book)]);
  assert.deepEqual(Object.keys(state.latestLookup.results).sort(), ['kcls', 'spl']);
  assert.equal((await run('kcls', book)).cached, true);
  assert.equal((await run('spl', book)).cached, true);
  assert.equal(calls, 2);
});

test('cached results expire at 10 minutes and preserve query elapsed time', async () => {
  let calls = 0;
  const env = setup(async () => { calls++; env.advance(250); return { noResults: true }; });
  assert.equal((await env.run('kcls', book)).elapsedMs, 250);
  env.advance(599999);
  assert.equal((await env.run('kcls', book)).cached, true);
  env.advance(1);
  assert.equal((await env.run('kcls', book)).cached, false);
  assert.equal(calls, 2);
});

test('a new book replaces the one cache slot', async () => {
  let calls = 0;
  const { run, state } = setup(async () => { calls++; return {}; });
  await run('kcls', book);
  await run('spl', { title: 'Another book' });
  assert.deepEqual(Object.keys(state.latestLookup.results), ['spl']);
  assert.equal((await run('kcls', book)).cached, false);
  assert.equal(calls, 3);
});

test('late previous-book response cannot replace the current book cache', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { run, state } = setup(async (_, input) => { if (input.title === book.title) await gate; return {}; });
  const old = run('kcls', book);
  await new Promise(resolve => setImmediate(resolve));
  await run('spl', { title: 'New book' });
  finish();
  await old;
  assert.equal(JSON.parse(state.latestLookup.key).title, 'New book');
  assert.deepEqual(Object.keys(state.latestLookup.results), ['spl']);
});

test('failed lookups are retried rather than cached', async () => {
  let calls = 0;
  const { run, state } = setup(async () => { calls++; if (calls === 1) throw new Error('Offline'); return {}; });
  await assert.rejects(run('kcls', book), /Offline/);
  assert.equal(state.latestLookup, undefined);
  assert.equal((await run('kcls', book)).cached, false);
  assert.equal(calls, 2);
});

test('unknown libraries and invalid books never reach network lookup', async () => {
  let calls = 0;
  const { run } = setup(async () => { calls++; return {}; });
  for (const library of ['evil', 'https://evil.test', '__proto__', 'constructor', 'toString']) {
    await assert.rejects(run(library, book), /Unknown library/);
  }
  await assert.rejects(run('kcls', { title: '', isbn: 'invalid' }), /title or ISBN/);
  assert.equal(calls, 0);
});

test('clearing after a fill removes cached data and prevents late responses restoring it', async () => {
  const finishes = [];
  let calls = 0;
  const { run, state } = setup(async () => { calls++; if (calls > 1) await new Promise(resolve => finishes.push(resolve)); return { call: calls }; });
  await run('kcls', book);
  await run.clearCache();
  const pending = run('kcls', book);
  await new Promise(resolve => setImmediate(resolve));
  await run.clearCache();
  assert.equal(state.latestLookup, undefined);
  const refreshed = run('kcls', book);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3, 'refresh starts a new request instead of reusing the pre-clear in-flight lookup');
  finishes[0]();
  finishes[1]();
  await Promise.all([pending, refreshed]);
  assert.equal(state.latestLookup.results.kcls.response.result.call, 3, 'the refreshed result is cached and the stale in-flight response cannot replace it');
});
