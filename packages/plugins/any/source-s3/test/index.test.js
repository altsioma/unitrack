import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createS3SourceProvider } from '../src/index.js';
import { assertSourceProviderConformance } from '@unitrack/conformance-kit';
import { startTestServer, headHandler } from './helpers/testServer.js';

/**
 * @param {string} pluginId
 * @param {string} key
 * @param {string} [kind]
 */
function refFor(pluginId, key, kind = 'object-storage') {
  return { pluginId, token: { pluginId, token: key }, kind };
}

/** @param {string} baseUrl */
function providerFor(baseUrl, overrides = {}) {
  return createS3SourceProvider({
    endpoint: baseUrl,
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    ...overrides,
  });
}

test("canResolve returns true only for a ref targeting this provider's id", async () => {
  const provider = providerFor('http://example.invalid');
  assert.equal(await provider.canResolve(refFor('s3', 'x')), true);
  assert.equal(await provider.canResolve(refFor('subsonic', 'x', 'self-hosted')), false);
});

test('id defaults to "s3" and can be overridden, so two buckets can be registered side by side', async () => {
  const a = providerFor('http://a.invalid');
  const b = providerFor('http://b.invalid', { id: 's3-backup' });
  assert.equal(a.id, 's3');
  assert.equal(b.id, 's3-backup');
  assert.equal(await a.canResolve(refFor('s3-backup', 'x')), false);
  assert.equal(await b.canResolve(refFor('s3-backup', 'x')), true);
});

test('exposes online, revalidation-required capabilities', () => {
  const provider = providerFor('http://example.invalid');
  assert.deepEqual(provider.capabilities, { offline: false, requiresRevalidation: true });
});

test('initialize and dispose resolve without throwing', async () => {
  const provider = providerFor('http://example.invalid');
  await provider.initialize({});
  await provider.dispose();
});

test('resolve() against a healthy HEAD returns a presigned URL for the requested key and the real Content-Type', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200, contentType: 'audio/flac' }));
  try {
    const provider = providerFor(baseUrl, { forcePathStyle: true });
    const resolved = await provider.resolve(refFor('s3', 'music/track-42.flac'));
    assert.equal(resolved.kind, 'url');
    assert.equal(resolved.mime, 'audio/flac');
    const url = new URL(resolved.url);
    assert.ok(url.pathname.includes('my-bucket'), `expected path-style bucket in ${url.pathname}`);
    assert.ok(url.pathname.endsWith('track-42.flac'), `expected key in ${url.pathname}`);
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  } finally {
    await close();
  }
});

test('resolve() falls back to application/octet-stream when the server sends no Content-Type', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200 }));
  try {
    const provider = providerFor(baseUrl);
    const resolved = await provider.resolve(refFor('s3', 'k'));
    assert.equal(resolved.mime, 'application/octet-stream');
  } finally {
    await close();
  }
});

test('resolve() rejects with an access-denied message on 403', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 403 }));
  try {
    const provider = providerFor(baseUrl);
    await assert.rejects(() => provider.resolve(refFor('s3', 'k')), /access denied/);
  } finally {
    await close();
  }
});

test('resolve() rejects with a not-found message on 404', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 404 }));
  try {
    const provider = providerFor(baseUrl);
    await assert.rejects(() => provider.resolve(refFor('s3', 'k')), /not found/);
  } finally {
    await close();
  }
});

test('resolve() rejects on another non-2xx HTTP status', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 503 }));
  try {
    const provider = providerFor(baseUrl);
    await assert.rejects(() => provider.resolve(refFor('s3', 'k')), /HTTP 503/);
  } finally {
    await close();
  }
});

test('resolve() rejects when the server never responds, within the configured timeout', async () => {
  const { baseUrl, close } = await startTestServer(() => {
    // Deliberately never call res.end() — simulates an unreachable/hanging endpoint.
  });
  try {
    const provider = providerFor(baseUrl, { timeoutMs: 50 });
    const start = Date.now();
    await assert.rejects(() => provider.resolve(refFor('s3', 'k')));
    assert.ok(Date.now() - start < 2000, 'rejected promptly via the configured timeout, not a default/hung wait');
  } finally {
    await close();
  }
});

test('revalidate() re-presigns and returns valid:true with the same token when the object is reachable', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200, contentType: 'audio/mpeg' }));
  try {
    const provider = providerFor(baseUrl);
    const token = { pluginId: 's3', token: 'k' };
    const result = await provider.revalidate(token);
    assert.equal(result.valid, true);
    assert.deepEqual(result.token, token);
  } finally {
    await close();
  }
});

test('revalidate() returns valid:false with a reason when the object is inaccessible', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 403 }));
  try {
    const provider = providerFor(baseUrl);
    const result = await provider.revalidate({ pluginId: 's3', token: 'k' });
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /access denied/);
  } finally {
    await close();
  }
});

test('passes @unitrack/conformance-kit\'s assertSourceProviderConformance', async () => {
  const { baseUrl, close } = await startTestServer(headHandler({ status: 200, contentType: 'audio/flac' }));
  try {
    const provider = providerFor(baseUrl);
    await assertSourceProviderConformance(provider, refFor('s3', 'conformance-key'));
  } finally {
    await close();
  }
});
