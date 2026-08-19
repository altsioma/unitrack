import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSubsonicSourceProvider } from '../src/index.js';
import { startTestServer, pingHandler } from './helpers/testServer.js';

/**
 * @param {string} pluginId
 * @param {string} trackId
 * @param {string} [kind]
 */
function refFor(pluginId, trackId, kind = 'self-hosted') {
  return { pluginId, token: { pluginId, token: trackId }, kind };
}

test("canResolve returns true only for a ref targeting this provider's id", async () => {
  const provider = createSubsonicSourceProvider({ baseUrl: 'http://example.invalid', username: 'u', password: 'p' });
  assert.equal(await provider.canResolve(refFor('subsonic', 'x')), true);
  assert.equal(await provider.canResolve(refFor('local-fs', 'x', 'local')), false);
});

test('id defaults to "subsonic" and can be overridden, so two servers can be registered side by side', async () => {
  const a = createSubsonicSourceProvider({ baseUrl: 'http://a.invalid', username: 'u', password: 'p' });
  const b = createSubsonicSourceProvider({ baseUrl: 'http://b.invalid', username: 'u', password: 'p', id: 'subsonic-backup' });
  assert.equal(a.id, 'subsonic');
  assert.equal(b.id, 'subsonic-backup');
  assert.equal(await a.canResolve(refFor('subsonic-backup', 'x')), false);
  assert.equal(await b.canResolve(refFor('subsonic-backup', 'x')), true);
});

test('exposes online, revalidation-required capabilities', () => {
  const provider = createSubsonicSourceProvider({ baseUrl: 'http://example.invalid', username: 'u', password: 'p' });
  assert.deepEqual(provider.capabilities, { offline: false, requiresRevalidation: true });
});

test('initialize and dispose resolve without throwing', async () => {
  const provider = createSubsonicSourceProvider({ baseUrl: 'http://example.invalid', username: 'u', password: 'p' });
  await provider.initialize({});
  await provider.dispose();
});

test('resolve() against a healthy server returns a correctly-signed stream.view URL', async () => {
  const { baseUrl, close } = await startTestServer(pingHandler({ status: 'ok' }));
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame', clientName: 'unitrack-test' });
    const resolved = await provider.resolve(refFor('subsonic', 'track-42'));
    assert.equal(resolved.kind, 'url');
    const url = new URL(resolved.url);
    assert.equal(url.pathname, '/rest/stream.view');
    assert.equal(url.searchParams.get('u'), 'alice');
    assert.equal(url.searchParams.get('v'), '1.16.1');
    assert.equal(url.searchParams.get('c'), 'unitrack-test');
    assert.equal(url.searchParams.get('id'), 'track-42');
    assert.equal(url.searchParams.get('format'), 'raw');
    assert.equal(resolved.mime, 'application/octet-stream');
    const salt = url.searchParams.get('s');
    const token = url.searchParams.get('t');
    assert.equal(token, createHash('md5').update('sesame' + salt, 'utf8').digest('hex'));
  } finally {
    await close();
  }
});

test('two consecutive resolve() calls use different salts', async () => {
  const { baseUrl, close } = await startTestServer(pingHandler({ status: 'ok' }));
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame' });
    const first = await provider.resolve(refFor('subsonic', 't1'));
    const second = await provider.resolve(refFor('subsonic', 't1'));
    const saltA = new URL(first.url).searchParams.get('s');
    const saltB = new URL(second.url).searchParams.get('s');
    assert.notEqual(saltA, saltB);
  } finally {
    await close();
  }
});

test('resolve() rejects when the server reports wrong credentials', async () => {
  const { baseUrl, close } = await startTestServer(
    pingHandler({ status: 'failed', errorCode: 40, errorMessage: 'Wrong username or password.' })
  );
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'wrong' });
    await assert.rejects(
      () => provider.resolve(refFor('subsonic', 't1')),
      /Wrong username or password\..*code 40/
    );
  } finally {
    await close();
  }
});

test('resolve() rejects on a non-2xx HTTP status from ping.view', async () => {
  const { baseUrl, close } = await startTestServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('service unavailable');
  });
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame' });
    await assert.rejects(
      () => provider.resolve(refFor('subsonic', 't1')),
      /HTTP 503/
    );
  } finally {
    await close();
  }
});

test('resolve() rejects when the server never responds, within the configured timeout', async () => {
  const { baseUrl, close } = await startTestServer(() => {
    // Deliberately never call res.end() — simulates an unreachable/hanging server.
  });
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame', timeoutMs: 50 });
    const start = Date.now();
    await assert.rejects(() => provider.resolve(refFor('subsonic', 't1')));
    assert.ok(Date.now() - start < 2000, 'rejected promptly via the configured timeout, not a default/hung wait');
  } finally {
    await close();
  }
});

test('revalidate() re-signs a fresh URL and returns valid:true with the same token when the server is healthy', async () => {
  const { baseUrl, close } = await startTestServer(pingHandler({ status: 'ok' }));
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame' });
    const token = { pluginId: 'subsonic', token: 't1' };
    const result = await provider.revalidate(token);
    assert.equal(result.valid, true);
    assert.deepEqual(result.token, token);
  } finally {
    await close();
  }
});

test('revalidate() returns valid:false with a reason when the server rejects credentials', async () => {
  const { baseUrl, close } = await startTestServer(
    pingHandler({ status: 'failed', errorCode: 40, errorMessage: 'Wrong username or password.' })
  );
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'wrong' });
    const result = await provider.revalidate({ pluginId: 'subsonic', token: 't1' });
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /Wrong username or password\..*code 40/);
  } finally {
    await close();
  }
});
