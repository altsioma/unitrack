import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrack, TrackResolutionError } from '../src/Resolver.js';
import { createMockSourceProvider } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('resolves via the first matching policy rule and source', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const streaming = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://spotify/track', mime: 'audio/flac' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'spotify', token: { pluginId: 'spotify', token: 's1' }, kind: 'streaming' },
    { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' },
  ]);
  const policy = [{ kind: 'local' }, { kind: 'streaming' }];
  const resolved = await resolveTrack(track, policy, [local, streaming]);
  assert.deepEqual(resolved, { kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' });
});

test('falls back to the next source within the same rule when resolve rejects', async () => {
  const failing = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const working = createMockSourceProvider({
    id: 'local-fs-2', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///b.flac', mime: 'audio/flac' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' },
    { pluginId: 'local-fs-2', token: { pluginId: 'local-fs-2', token: 'l2' }, kind: 'local' },
  ]);
  const resolved = await resolveTrack(track, [{ kind: 'local' }], [failing, working]);
  assert.deepEqual(resolved, { kind: 'url', url: 'file:///b.flac', mime: 'audio/flac' });
});

test('falls back to the next rule when no source in the current rule resolves', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const streaming = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://spotify/track', mime: 'audio/flac' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' },
    { pluginId: 'spotify', token: { pluginId: 'spotify', token: 's1' }, kind: 'streaming' },
  ]);
  const policy = [{ kind: 'local' }, { kind: 'streaming' }];
  const resolved = await resolveTrack(track, policy, [local, streaming]);
  assert.deepEqual(resolved, { kind: 'url', url: 'https://spotify/track', mime: 'audio/flac' });
});

test('respects a pluginId-specific rule over other providers of the same kind', async () => {
  const spotify = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://spotify/track', mime: 'audio/flac' }),
  });
  const tidal = createMockSourceProvider({
    id: 'tidal', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://tidal/track', mime: 'audio/flac' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'tidal', token: { pluginId: 'tidal', token: 't1' }, kind: 'streaming' },
    { pluginId: 'spotify', token: { pluginId: 'spotify', token: 's1' }, kind: 'streaming' },
  ]);
  const resolved = await resolveTrack(track, [{ kind: 'streaming', pluginId: 'spotify' }], [spotify, tidal]);
  assert.deepEqual(resolved, { kind: 'url', url: 'https://spotify/track', mime: 'audio/flac' });
});

test('records a failure and skips a source whose provider is not registered', async () => {
  const track = makeTrack('t1', [{ pluginId: 'missing-plugin', token: { pluginId: 'missing-plugin', token: 'x1' }, kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], []),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        { pluginId: 'missing-plugin', token: { pluginId: 'missing-plugin', token: 'x1' }, reason: 'no provider registered for pluginId' },
      ]);
      return true;
    }
  );
});

test('records a failure and skips a source the provider declines via canResolve', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
    canResolveImpl: () => false,
  });
  const track = makeTrack('t1', [{ pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [provider]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, reason: 'provider cannot resolve this source' },
      ]);
      return true;
    }
  );
});

test('throws TrackResolutionError with the track id and all failure reasons when nothing resolves', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const track = makeTrack('t1', [{ pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [local]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.equal(err.trackId, 't1');
      assert.deepEqual(err.failedSources, [
        { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, reason: 'file missing' },
      ]);
      return true;
    }
  );
});

test('retries once via revalidate() — called with just the token, not the whole ref — when a requiresRevalidation provider fails to resolve', async () => {
  const attempts = [];
  const provider = createMockSourceProvider({
    id: 'subsonic', kind: 'streaming',
    capabilities: { offline: false, requiresRevalidation: true },
    resolveImpl: async (ref) => {
      attempts.push(ref.token.token);
      if (ref.token.token === 'stale') throw new Error('expired token');
      return { kind: 'url', url: `https://example/${ref.token.token}`, mime: 'audio/flac' };
    },
    revalidateImpl: async (token) => {
      assert.deepEqual(token, { pluginId: 'subsonic', token: 'stale' });
      return { valid: true, token: { pluginId: 'subsonic', token: 'fresh' } };
    },
  });
  const track = makeTrack('t1', [{ pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 'stale' }, kind: 'streaming' }]);
  const resolved = await resolveTrack(track, [{ kind: 'streaming' }], [provider]);
  assert.deepEqual(resolved, { kind: 'url', url: 'https://example/fresh', mime: 'audio/flac' });
  assert.deepEqual(attempts, ['stale', 'fresh']);
});

test('gives up after a revalidated token also fails to resolve', async () => {
  const provider = createMockSourceProvider({
    id: 'subsonic', kind: 'streaming',
    capabilities: { offline: false, requiresRevalidation: true },
    resolveImpl: async () => { throw new Error('still broken'); },
    revalidateImpl: async () => ({ valid: true, token: { pluginId: 'subsonic', token: 'fresh' } }),
  });
  const track = makeTrack('t1', [{ pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 'stale' }, kind: 'streaming' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'streaming' }], [provider]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.equal(err.failedSources[0].reason, 'still broken');
      return true;
    }
  );
});

test('rejects a SourceRef whose pluginId does not match its own token.pluginId, without ever calling the matching provider', async () => {
  let canResolveCalls = 0;
  let resolveCalls = 0;
  let revalidateCalls = 0;
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    capabilities: { offline: true, requiresRevalidation: true },
    canResolveImpl: () => { canResolveCalls += 1; return true; },
    resolveImpl: async () => { resolveCalls += 1; return { kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }; },
    revalidateImpl: async (token) => { revalidateCalls += 1; return { valid: true, token }; },
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', token: { pluginId: 'not-local-fs', token: 'l1' }, kind: 'local' },
  ]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [provider]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        {
          pluginId: 'local-fs',
          token: { pluginId: 'not-local-fs', token: 'l1' },
          reason: 'SourceRef.pluginId does not match token.pluginId',
        },
      ]);
      return true;
    }
  );
  assert.equal(canResolveCalls, 0, 'canResolve must never be called for a mismatched ref');
  assert.equal(resolveCalls, 0, 'resolve must never be called for a mismatched ref');
  assert.equal(revalidateCalls, 0, 'revalidate must never be called for a mismatched ref');
});

test('gives up without retrying resolve() when revalidate() itself reports invalid', async () => {
  const provider = createMockSourceProvider({
    id: 'subsonic', kind: 'streaming',
    capabilities: { offline: false, requiresRevalidation: true },
    resolveImpl: async () => { throw new Error('expired token'); },
    revalidateImpl: async () => ({ valid: false, reason: 'no longer authorized' }),
  });
  const track = makeTrack('t1', [{ pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 'stale' }, kind: 'streaming' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'streaming' }], [provider]),
    (err) => {
      assert.equal(err.failedSources[0].reason, 'expired token');
      return true;
    }
  );
});
