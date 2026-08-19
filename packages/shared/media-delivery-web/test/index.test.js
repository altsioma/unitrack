import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireWebMediaUrl } from '../src/index.js';
import { createFakeFetch, createFakeResponse, createFakeObjectUrlRegistry } from './helpers/fetchStubs.js';

/**
 * Monkey-patches the global fetch/URL.createObjectURL/URL.revokeObjectURL
 * for the duration of `fn`, restoring the originals afterward regardless of
 * outcome. acquireWebMediaUrl() deliberately has no injection point for
 * these (its signature is fixed by the design spec), so this is the only
 * way to test it without a real network or a real DOM.
 * @param {{ fetchImpl?: any, urlRegistry?: ReturnType<typeof createFakeObjectUrlRegistry> }} stubs
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withStubbedGlobals({ fetchImpl, urlRegistry }, fn) {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  if (urlRegistry) {
    globalThis.URL.createObjectURL = urlRegistry.createObjectURL;
    globalThis.URL.revokeObjectURL = urlRegistry.revokeObjectURL;
  }
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  }
}

test('a header-less ResolvedSource is a pure passthrough — no fetch, url unchanged, release() is a no-op', async () => {
  let fetchCalled = false;
  await withStubbedGlobals({ fetchImpl: async () => { fetchCalled = true; return createFakeResponse(); } }, async () => {
    const lease = await acquireWebMediaUrl({ kind: 'url', url: 'https://example.com/a.flac', mime: 'audio/flac' });
    assert.equal(lease.url, 'https://example.com/a.flac');
    assert.doesNotThrow(() => lease.release());
  });
  assert.equal(fetchCalled, false, 'no fetch for a header-less URL');
});

test('a ResolvedSource with an empty headers object is also treated as a passthrough', async () => {
  let fetchCalled = false;
  await withStubbedGlobals({ fetchImpl: async () => { fetchCalled = true; return createFakeResponse(); } }, async () => {
    const lease = await acquireWebMediaUrl({ kind: 'url', url: 'https://example.com/a.flac', mime: 'audio/flac', headers: {} });
    assert.equal(lease.url, 'https://example.com/a.flac');
  });
  assert.equal(fetchCalled, false);
});

test('a header-bearing ResolvedSource fetches with the exact headers and signal given, and yields a fresh object URL', async () => {
  const controller = new AbortController();
  /** @type {any} */
  let capturedUrl;
  /** @type {any} */
  let capturedInit;
  const urlRegistry = createFakeObjectUrlRegistry();

  await withStubbedGlobals({
    fetchImpl: createFakeFetch({
      response: createFakeResponse(),
      capture: (url, init) => { capturedUrl = url; capturedInit = init; },
    }),
    urlRegistry,
  }, async () => {
    const lease = await acquireWebMediaUrl(
      { kind: 'url', url: 'https://example.com/a.flac', mime: 'audio/flac', headers: { Authorization: 'Bearer secret-token' } },
      { signal: controller.signal }
    );
    assert.equal(capturedUrl, 'https://example.com/a.flac');
    assert.deepEqual(capturedInit.headers, { Authorization: 'Bearer secret-token' });
    assert.equal(capturedInit.signal, controller.signal);
    assert.equal(lease.url, 'blob:fake-1');
  });
});

test('a non-OK response rejects with a sanitized error that never includes the raw headers or token-bearing URL parts', async () => {
  const headers = { Authorization: 'Bearer super-secret-token' };
  await withStubbedGlobals({
    fetchImpl: createFakeFetch({ response: createFakeResponse({ ok: false, status: 403 }) }),
  }, async () => {
    await assert.rejects(
      () => acquireWebMediaUrl({
        kind: 'url',
        url: 'https://example.com/stream/track-1?token=super-secret-token',
        mime: 'audio/flac',
        headers,
      }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /403/);
        assert.match(err.message, /"url"/);
        assert.match(err.message, /https:\/\/example\.com/, 'redacted origin is present');
        assert.doesNotMatch(err.message, /super-secret-token/);
        assert.doesNotMatch(err.message, /Authorization/);
        assert.doesNotMatch(err.message, /\/stream\/track-1/, 'path is redacted along with the query string');
        const causeText = err.cause == null ? '' : JSON.stringify(err.cause);
        assert.equal(causeText.includes('super-secret-token'), false);
        return true;
      }
    );
  });
});

test('release() is idempotent — calling it twice only revokes the object URL once', async () => {
  const urlRegistry = createFakeObjectUrlRegistry();
  await withStubbedGlobals({
    fetchImpl: createFakeFetch({ response: createFakeResponse() }),
    urlRegistry,
  }, async () => {
    const lease = await acquireWebMediaUrl({
      kind: 'url', url: 'https://example.com/a.flac', mime: 'audio/flac', headers: { 'X-Test': '1' },
    });
    lease.release();
    lease.release();
    assert.deepEqual(urlRegistry.revokedUrls, ['blob:fake-1']);
  });
});

test('an aborted signal propagates as a rejected promise, not a silent hang', async () => {
  const controller = new AbortController();
  await withStubbedGlobals({
    fetchImpl: createFakeFetch({ response: createFakeResponse(), delayMs: 5 }),
  }, async () => {
    const promise = acquireWebMediaUrl(
      { kind: 'url', url: 'https://example.com/a.flac', mime: 'audio/flac', headers: { 'X-Test': '1' } },
      { signal: controller.signal }
    );
    controller.abort();
    await assert.rejects(() => promise, /aborted/i);
  });
});

test('a signal that is already aborted before the call rejects immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  await withStubbedGlobals({
    fetchImpl: createFakeFetch({ response: createFakeResponse() }),
  }, async () => {
    await assert.rejects(
      () => acquireWebMediaUrl(
        { kind: 'url', url: 'https://example.com/a.flac', mime: 'audio/flac', headers: { 'X-Test': '1' } },
        { signal: controller.signal }
      ),
      /aborted/i
    );
  });
});
