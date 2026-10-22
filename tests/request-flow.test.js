import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARIES } from '../extension/lib/catalog.js';

let sequence = 0;
async function setup(libraryId, { createFails = false, onCreate, fillResult = { ok: true } } = {}) {
  const entry = { id: `request-${++sequence}`, libraryId, book: { title: 'Example book', author: 'Example author', isbn: '9780593135204' }, savedAt: Date.now() };
  const state = { pendingPurchaseBook: entry, latestLookup: { key: 'cached', results: {} } };
  const calls = { creates: [], updates: [], injections: [] };
  const listeners = {};
  const url = LIBRARIES[libraryId].requestUrl;
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  globalThis.chrome = {
    runtime: { id: 'library-lens-test', getURL: path => `chrome-extension://library-lens-test/${path}`, onMessage: event('message') },
    storage: {
      session: {
        async get(key) { return structuredClone({ [key]: state[key] }); },
        async set(values) { Object.assign(state, structuredClone(values)); },
        async remove(key) { delete state[key]; }
      },
      onChanged: event('storage')
    },
    tabs: {
      async create(options) { calls.creates.push(options); if (createFails) throw new Error('Could not open tab'); await onCreate?.(state); return { id: 42, url }; },
      async update(...args) { calls.updates.push(args); throw new Error('Request flow must open the final URL directly'); },
      async get(id) { return { id, url }; },
      async sendMessage() {},
      onUpdated: event('updated'), onRemoved: event('removed')
    },
    scripting: { async executeScript(options) { calls.injections.push(options); return [{ result: fillResult }]; } }
  };
  await import(`../extension/background.js?request-flow=${sequence}`);
  const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
  const sender = (overrides = {}) => ({ id: chrome.runtime.id, url, tab: { id: 42 }, frameId: 0, ...overrides });
  const send = (message, source = popup) => new Promise(resolve => {
    assert.equal(listeners.message(message, source, resolve), true);
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { entry, state, calls, listeners, send, sender, settle, url };
}

// Chrome globals belong to one mocked worker at a time; keep these tests sequential.
for (const libraryId of ['kcls', 'spl']) {
  test(`${libraryId}: opens official request URL directly and attaches helper in its request tab`, async () => {
    const env = await setup(libraryId);
    assert.deepEqual(await env.send({ type: 'OPEN_REQUEST', entryId: env.entry.id }), { ok: true, tabId: 42 });
    await env.settle();
    assert.deepEqual(env.calls.creates, [{ url: env.url }]);
    assert.deepEqual(env.calls.updates, []);
    assert.equal(env.state.pendingPurchaseBook.tabId, 42);
    assert.ok(env.calls.injections.length > 0);
    for (const injection of env.calls.injections) {
      assert.equal(injection.target.tabId, 42);
      assert.equal(injection.func.name, 'installRequestHelper');
      assert.deepEqual(injection.args, [env.entry.id, libraryId]);
    }
    env.calls.injections.length = 0;
    env.listeners.updated(99, { status: 'complete' });
    await env.settle();
    assert.equal(env.calls.injections.length, 0);
    env.listeners.updated(42, { status: 'complete' });
    await env.settle();
    assert.equal(env.calls.injections.length, 1);
  });

  test(`${libraryId}: only the prepared top-level request tab can fill, and success clears book and cache`, async () => {
    const env = await setup(libraryId);
    await env.send({ type: 'OPEN_REQUEST', entryId: env.entry.id });
    await env.settle();
    env.calls.injections.length = 0;
    const message = { type: 'FILL_REQUEST', entryId: env.entry.id };
    for (const source of [env.sender({ tab: { id: 99 } }), env.sender({ frameId: 1 }), env.sender({ url: 'https://example.com/' })]) {
      assert.equal((await env.send(message, source)).ok, false);
      assert.ok(env.state.pendingPurchaseBook);
      assert.equal(env.calls.injections.length, 0);
    }
    assert.equal((await env.send(message, env.sender())).ok, true);
    assert.equal(env.calls.injections.length, 1);
    assert.equal(env.calls.injections[0].func.name, 'pasteBookDetails');
    assert.deepEqual(env.calls.injections[0].args, [libraryId, env.entry.book]);
    assert.equal(env.state.pendingPurchaseBook, undefined);
    assert.equal(env.state.latestLookup, undefined);
  });

  test(`${libraryId}: failure to create request tab preserves the prepared book`, async () => {
    const env = await setup(libraryId, { createFails: true });
    const result = await env.send({ type: 'OPEN_REQUEST', entryId: env.entry.id });
    assert.equal(result.ok, false);
    assert.match(result.message, /Could not open tab/);
    assert.deepEqual(env.state.pendingPurchaseBook, env.entry);
    assert.equal(env.calls.injections.length, 0);
  });

  test(`${libraryId}: opening a request cannot resurrect a forgotten or replaced book`, async () => {
    for (const replacement of [null, { id: 'newer-book', libraryId, book: { title: 'Newer book' }, savedAt: Date.now() }]) {
      const env = await setup(libraryId, { onCreate(state) {
        if (replacement) state.pendingPurchaseBook = structuredClone(replacement);
        else delete state.pendingPurchaseBook;
      } });
      const result = await env.send({ type: 'OPEN_REQUEST', entryId: env.entry.id });
      assert.equal(result.ok, false);
      assert.match(result.message, /Prepared book changed/);
      assert.deepEqual(env.state.pendingPurchaseBook, replacement || undefined);
      assert.equal(env.calls.injections.length, 0);
    }
  });
}
