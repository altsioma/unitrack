import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectUrlSourceProvider } from '../src/index.js';
import { assertSourceProviderConformance } from '@unitrack/conformance-kit';
import { startTestServer, headHandler } from './helpers/testServer.js';

/**
 * @param {string} pluginId
 * @param {string} url
 */
function refFor(pluginId, url) {
  return { pluginId, token: { pluginId, token: url }, kind: 'direct-url' };
}

/** @param {{ id?: string, timeoutMs?: number }} [overrides] */
function providerFor(overrides = {}) {
  return createDirectUrlSourceProvider(overrides);
}

test("canResolve returns true only for a ref targeting this provider's id", async () => {
  const provider = providerFor();
  assert.equal(await provider.canResolve(refFor('direct-url', 'http://example.invalid/track.flac')), true);
  assert.equal(await provider.canResolve(refFor('s3', 'http://example.invalid/track.flac')), false);
});

test('id defaults to "direct-url" and can be overridden', async () => {
  const a = providerFor();
  const b = providerFor({ id: 'direct-url-2' });
  assert.equal(a.id, 'direct-url');
  assert.equal(b.id, 'direct-url-2');
  assert.equal(await a.canResolve(refFor('direct-url-2', 'x')), false);
  assert.equal(await b.canResolve(refFor('direct-url-2', 'x')), true);
});

test('exposes online, revalidation-required capabilities', () => {
  const provider = providerFor();
  assert.deepEqual(provider.capabilities, { offline: false, requiresRevalidation: true });
});

test('initialize and dispose resolve without throwing', async () => {
  const provider = providerFor();
  await provider.initialize({});
  await provider.dispose();
});

test('resolve() against a healthy HEAD returns the same URL and the real Content-Type', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200, contentType: 'audio/flac' }));
  try {
    const provider = providerFor();
    const url = `${baseUrl}/track.flac`;
    const resolved = await provider.resolve(refFor('direct-url', url));
    assert.deepEqual(resolved, { kind: 'url', url, mime: 'audio/flac' });
  } finally {
    await close();
  }
});

test('resolve() falls back to application/octet-stream when the server sends no Content-Type', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200 }));
  try {
    const provider = providerFor();
    const resolved = await provider.resolve(refFor('direct-url', `${baseUrl}/track.flac`));
    assert.equal(resolved.mime, 'application/octet-stream');
  } finally {
    await close();
  }
});

test('resolve() rejects with an access-denied message on 403', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 403 }));
  try {
    const provider = providerFor();
    await assert.rejects(() => provider.resolve(refFor('direct-url', baseUrl)), /access denied/);
  } finally {
    await close();
  }
});

test('resolve() rejects with a not-found message on 404', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 404 }));
  try {
    const provider = providerFor();
    await assert.rejects(() => provider.resolve(refFor('direct-url', baseUrl)), /not found/);
  } finally {
    await close();
  }
});

test('resolve() rejects on another non-2xx HTTP status', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 503 }));
  try {
    const provider = providerFor();
    await assert.rejects(() => provider.resolve(refFor('direct-url', baseUrl)), /HTTP 503/);
  } finally {
    await close();
  }
});

test('resolve() rejects when the server never responds, within the configured timeout', async () => {
  const { baseUrl, close } = await startTestServer(() => {
    // Deliberately never call res.end() — simulates an unreachable/hanging URL.
  });
  try {
    const provider = providerFor({ timeoutMs: 50 });
    const start = Date.now();
    await assert.rejects(() => provider.resolve(refFor('direct-url', baseUrl)));
    assert.ok(Date.now() - start < 2000, 'rejected promptly via the configured timeout, not a default/hung wait');
  } finally {
    await close();
  }
});

test('revalidate() re-HEADs the same URL and returns valid:true with the same token when reachable', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200, contentType: 'audio/mpeg' }));
  try {
    const provider = providerFor();
    const token = { pluginId: 'direct-url', token: `${baseUrl}/track.mp3` };
    const result = await provider.revalidate(token);
    assert.equal(result.valid, true);
    assert.deepEqual(result.token, token);
  } finally {
    await close();
  }
});

test('revalidate() returns valid:false with a reason when the URL is inaccessible', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 404 }));
  try {
    const provider = providerFor();
    const result = await provider.revalidate({ pluginId: 'direct-url', token: baseUrl });
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /not found/);
  } finally {
    await close();
  }
});

test('passes @unitrack/conformance-kit\'s assertSourceProviderConformance', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200, contentType: 'audio/flac' }));
  try {
    const provider = providerFor();
    await assertSourceProviderConformance(provider, refFor('direct-url', `${baseUrl}/conformance.flac`));
  } finally {
    await close();
  }
});
