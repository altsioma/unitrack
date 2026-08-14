import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrack, TrackResolutionError } from '../src/Resolver.js';
import { createMockSourceProvider } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('resolves via the first matching policy rule and source', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const streaming = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://spotify/track' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'spotify', sourceId: 's1', kind: 'streaming' },
    { pluginId: 'local-fs', sourceId: 'l1', kind: 'local' },
  ]);
  const policy = [{ kind: 'local' }, { kind: 'streaming' }];
  const resolved = await resolveTrack(track, policy, [local, streaming]);
  assert.deepEqual(resolved, { url: 'file:///a.flac' });
});

test('falls back to the next source within the same rule when resolve rejects', async () => {
  const failing = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const working = createMockSourceProvider({
    id: 'local-fs-2', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///b.flac' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', sourceId: 'l1', kind: 'local' },
    { pluginId: 'local-fs-2', sourceId: 'l2', kind: 'local' },
  ]);
  const resolved = await resolveTrack(track, [{ kind: 'local' }], [failing, working]);
  assert.deepEqual(resolved, { url: 'file:///b.flac' });
});

test('falls back to the next rule when no source in the current rule resolves', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const streaming = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://spotify/track' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', sourceId: 'l1', kind: 'local' },
    { pluginId: 'spotify', sourceId: 's1', kind: 'streaming' },
  ]);
  const policy = [{ kind: 'local' }, { kind: 'streaming' }];
  const resolved = await resolveTrack(track, policy, [local, streaming]);
  assert.deepEqual(resolved, { url: 'https://spotify/track' });
});

test('respects a pluginId-specific rule over other providers of the same kind', async () => {
  const spotify = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://spotify/track' }),
  });
  const tidal = createMockSourceProvider({
    id: 'tidal', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://tidal/track' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'tidal', sourceId: 't1', kind: 'streaming' },
    { pluginId: 'spotify', sourceId: 's1', kind: 'streaming' },
  ]);
  const resolved = await resolveTrack(track, [{ kind: 'streaming', pluginId: 'spotify' }], [spotify, tidal]);
  assert.deepEqual(resolved, { url: 'https://spotify/track' });
});

test('records a failure and skips a source whose provider is not registered', async () => {
  const track = makeTrack('t1', [{ pluginId: 'missing-plugin', sourceId: 'x1', kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], []),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        { pluginId: 'missing-plugin', sourceId: 'x1', reason: 'no provider registered for pluginId' },
      ]);
      return true;
    }
  );
});

test('records a failure and skips a source the provider declines via canResolve', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
    canResolveImpl: () => false,
  });
  const track = makeTrack('t1', [{ pluginId: 'local-fs', sourceId: 'l1', kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [provider]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        { pluginId: 'local-fs', sourceId: 'l1', reason: 'provider cannot resolve this source' },
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
  const track = makeTrack('t1', [{ pluginId: 'local-fs', sourceId: 'l1', kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [local]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.equal(err.trackId, 't1');
      assert.deepEqual(err.failedSources, [
        { pluginId: 'local-fs', sourceId: 'l1', reason: 'file missing' },
      ]);
      return true;
    }
  );
});
