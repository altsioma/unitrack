import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorePlayer, PluginsNotInitializedError } from '../src/CorePlayer.js';
import { CONTRACT_VERSION } from '../src/types.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('registerSourceProvider delegates to the internal registry (duplicate id throws)', () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }) });
  core.registerSourceProvider(provider);
  assert.throws(() => core.registerSourceProvider(provider), /already registered/);
});

test('registerPlaybackEngine delegates to the internal registry (duplicate id throws)', () => {
  const core = new CorePlayer();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerPlaybackEngine(engine);
  assert.throws(() => core.registerPlaybackEngine(engine), /already registered/);
});

test('registerMetadataProvider and registerPlaylistProvider delegate without throwing', () => {
  const core = new CorePlayer();
  assert.doesNotThrow(() => core.registerMetadataProvider({ id: 'mb', contractVersion: CONTRACT_VERSION, search: async () => [] }));
  assert.doesNotThrow(() => core.registerPlaylistProvider({ id: 'local', contractVersion: CONTRACT_VERSION, fetchPlaylist: async () => [] }));
});

test('queue mutations emit queueChanged on the core instance', async () => {
  const core = new CorePlayer();
  let fired = 0;
  core.on('queueChanged', () => { fired += 1; });
  await core.enqueue(makeTrack('t1'));
  assert.equal(fired, 1);
});

test('getState reflects the queue, policy, and default idle status', async () => {
  const core = new CorePlayer();
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(makeTrack('t1'));
  const state = core.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.queue.length, 1);
  assert.deepEqual(state.policy, [{ kind: 'local' }]);
  assert.equal(state.currentQueueItem, undefined);
  assert.equal(state.position, 0);
  assert.equal(state.duration, 0);
});

test('restoreState rebuilds the queue in order and preserves the current item', async () => {
  const core = new CorePlayer();
  const items = await core.enqueue([makeTrack('t1'), makeTrack('t2')]);
  await core.selectQueueItem(items[1].queueItemId);
  const snapshot = core.getState();

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  const restoredState = restored.getState();
  assert.equal(restoredState.queue.length, 2);
  assert.equal(restoredState.queue[0].track.id, 't1');
  assert.equal(restoredState.queue[1].track.id, 't2');
  assert.equal(restoredState.currentQueueItem.track.id, 't2');
  assert.deepEqual(restoredState.policy, snapshot.policy);
  assert.equal(restoredState.status, 'idle');
});

test('restoreState with no current item leaves the queue unselected', async () => {
  const core = new CorePlayer();
  await core.enqueue(makeTrack('t1'));
  const snapshot = core.getState();

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  assert.equal(restored.getState().currentQueueItem, undefined);
});

function trackWithLocalSource(id, sourceId = `${id}-src`) {
  return makeTrack(id, [{ pluginId: 'local-fs', token: { pluginId: 'local-fs', token: sourceId }, kind: 'local' }]);
}

test('play resolves the current track and starts the engine', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item));

  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' });
  assert.equal(engine.playCalls, 1);
  assert.equal(trackChanged.length, 1);
  assert.equal(trackChanged[0].track.id, 't1');
});

test('play on an empty queue is a no-op', async () => {
  const core = new CorePlayer();
  await core.initializePlugins({});
  await core.play();
  assert.equal(core.getState().status, 'idle');
});

test('play emits an error and stops when resolution fails for every source', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  core.registerSourceProvider(provider);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].trackId, 't1');
  // Redacted: pluginId + the token's own displayPath (undefined here, since
  // trackWithLocalSource's fixture token doesn't set one) — never the raw
  // token value ('t1-src').
  assert.deepEqual(errors[0].failedSources, [
    { pluginId: 'local-fs', displayPath: undefined, reason: 'file missing' },
  ]);
});

test('an "error" event\'s failedSources never contains the raw token value', async () => {
  const core = new CorePlayer();
  // A recognizable sentinel, grepped for below in the fully-serialized
  // event payload — proves the redaction holds regardless of exactly which
  // field of the failure shape might otherwise have carried it.
  const SENTINEL_TOKEN = 'THIS-RAW-TOKEN-MUST-NEVER-LEAK-abc123';
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  core.registerSourceProvider(provider);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(makeTrack('t1', [
    { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: SENTINEL_TOKEN }, kind: 'local' },
  ]));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(errors.length, 1);
  const serialized = JSON.stringify(errors[0]);
  assert.equal(serialized.includes(SENTINEL_TOKEN), false, 'the raw token must not appear anywhere in the serialized error payload');
});

test('play emits an error when no registered engine can play the resolved source', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio', canPlayImpl: () => false });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(core.getState().status, 'error');
  assert.equal(errors[0].reason, 'no playback engine registered for resolved source');
});

test('a throwing canPlay() surfaces as an error event instead of leaving status stuck at loading', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    canPlayImpl: () => { throw new Error('codec probe failed'); },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await assert.doesNotReject(() => core.play());

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].trackId, 't1');
  assert.equal(errors[0].reason, 'codec probe failed');
});

test('pause and resume do not re-resolve or reload the track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  await core.play();
  await core.pause();
  assert.equal(core.getState().status, 'paused');
  assert.equal(engine.pauseCalls, 1);

  await core.play();
  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.playCalls, 2);
});

test('stop resets status and position without clearing the queue', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  await core.play();
  await core.stop();

  const state = core.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.position, 0);
  assert.equal(state.queue.length, 1);
  assert.equal(engine.stopCalls, 1);
});

test('next loads and plays the following queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l2.flac', mime: 'audio/flac' });
});

test('next is a no-op at the end of the queue', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  await core.play();
  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.equal(engine.playCalls, 1);
});

test('prev loads and plays the preceding queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();
  await core.prev();

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l1.flac', mime: 'audio/flac' });
});

test('seek delegates to the active engine only once a track is loaded', async () => {
  const core = new CorePlayer();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerPlaybackEngine(engine);

  await core.seek(30);
  assert.deepEqual(engine.seekCalls, []);

  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  core.registerSourceProvider(provider);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();
  await core.seek(30);
  assert.deepEqual(engine.seekCalls, [30]);
});

test('engine progress events emit a throttled positionChanged', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  const positions = [];
  core.on('positionChanged', (payload) => positions.push(payload));

  engine._simulate('progress', { position: 1, duration: 100 });
  engine._simulate('progress', { position: 2, duration: 100 });

  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0], { position: 1, duration: 100 });
});

test('engine ended event auto-advances to the next queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
});

test('engine ended event sets status to idle when the queue is finished', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
});

test('engine error event during playback stops and emits error', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  engine._simulate('error', new Error('device disconnected'));

  assert.equal(core.getState().status, 'error');
  assert.equal(errors[0].reason, 'device disconnected');
  assert.equal(errors[0].trackId, 't1');
});

test('an engine error that arrives mid-load does not permanently disable reconciliation', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  let releaseLoad;
  const originalLoad = engine.load.bind(engine);
  engine.load = async (resolved) => {
    await new Promise((resolve) => { releaseLoad = resolve; });
    return originalLoad(resolved);
  };
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  const playPromise = core.play();
  await new Promise((resolve) => setImmediate(resolve));
  engine._simulate('error', new Error('transient'));
  releaseLoad();
  await playPromise;

  assert.equal(core.getState().status, 'playing');

  const current = core.getState().currentQueueItem;
  await core.removeFromQueue(current.queueItemId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('an engine load/play failure is caught and surfaced as an error event, not a rejection', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.play = async () => { throw new Error('device busy'); };
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await assert.doesNotReject(() => core.play());

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].trackId, 't1');
  assert.equal(errors[0].reason, 'device busy');
});

test('a resume failure (engine.play() rejecting from paused) is caught and surfaced as an error event', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  await core.play();
  await core.pause();
  assert.equal(core.getState().status, 'paused');

  engine.play = async () => { throw new Error('resume rejected'); };

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await assert.doesNotReject(() => core.play());

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, 'resume rejected');
  assert.equal(errors[0].trackId, 't1');
});

test('rebinding a previously-used playback engine does not register duplicate listeners', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engineA = createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: (resolved) => resolved.url.includes('l1') });
  const engineB = createMockPlaybackEngine({ id: 'engine-b', canPlayImpl: (resolved) => resolved.url.includes('l2') });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engineA);
  core.registerPlaybackEngine(engineB);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();
  await core.prev();

  assert.equal(engineA._listenerCount('progress'), 1);
  assert.equal(engineA._listenerCount('ended'), 1);
  assert.equal(engineA._listenerCount('error'), 1);
});

test('concurrent next() calls resolve in order rather than racing', async () => {
  const core = new CorePlayer();
  // The resolve for t2's source (l2) is deliberately slower than t3's
  // (l3). With trivially-resolving mocks of identical shape, two
  // overlapping next() calls happen to complete in start order even
  // without a concurrency guard, which would make this test pass
  // regardless of whether serialization exists. The delay is keyed to
  // l2's sourceId specifically (not a call counter) so it only affects
  // the race itself, not the earlier play() call that resolves t1/l1
  // during setup.
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => {
      if (ref.token.token === 'l2') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' };
    },
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([
    trackWithLocalSource('t1', 'l1'),
    trackWithLocalSource('t2', 'l2'),
    trackWithLocalSource('t3', 'l3'),
  ]);
  await core.play();

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item.track.id));

  await Promise.all([core.next(), core.next()]);

  assert.equal(core.getState().currentQueueItem.track.id, 't3');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l3.flac', mime: 'audio/flac' });
  assert.deepEqual(trackChanged, ['t2', 't3']);
});

test('pause() issued during an in-flight play() still ends up paused', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const playPromise = core.play();
  const pausePromise = core.pause();
  await Promise.all([playPromise, pausePromise]);

  assert.equal(core.getState().status, 'paused');
  assert.equal(engine.playCalls, 1);
  assert.equal(engine.pauseCalls, 1);
});

test('removing the currently-playing item stops playback and returns to idle', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  const current = core.getState().currentQueueItem;
  await core.removeFromQueue(current.queueItemId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('clearing the queue during playback stops playback and returns to idle', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  await core.clearQueue();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('reordering the queue during playback does not interrupt it', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  const current = core.getState().currentQueueItem;
  await core.reorderQueueItem(current.queueItemId, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.stopCalls, 0);
});

test('a direct selectQueueItem() pointer jump does not interrupt playback', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  const items = await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  await core.selectQueueItem(items[1].queueItemId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.stopCalls, 0);
});

test('play() after selectQueueItem() to a different item while already playing switches to that item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  const items = await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  await core.selectQueueItem(items[1].queueItemId);
  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l2.flac', mime: 'audio/flac' });
});

test('play() after selectQueueItem() to a different item while paused loads and plays the new item, not the old one', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  const items = await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();
  await core.pause();

  await core.selectQueueItem(items[1].queueItemId);
  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l2.flac', mime: 'audio/flac' });
});

test('play() with no queue-item change while already playing stays a no-op (regression guard)', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item));
  await core.play();

  await core.play();

  assert.equal(trackChanged.length, 1);
  assert.equal(engine.playCalls, 1);
});

test('normal next() navigation is unaffected by reconciliation', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  await core.next();

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.equal(engine.stopCalls, 0);
});

test('restoreState on an already-active instance does not leave a stale loaded-item reference', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  core.restoreState({
    status: 'idle',
    currentQueueItem: undefined,
    position: 42,
    duration: 0,
    queue: [],
    policy: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Before this task, restoreState() never stopped the active engine at
  // all (the bug this task fixes) — 0 was the old, wrong expectation.
  // Now restoreState() stops it exactly once, itself; this asserts that
  // reconciliation doesn't *also* fire a second, spurious stop on top of
  // that intentional one.
  assert.equal(core.getState().position, 42);
  assert.equal(engine.stopCalls, 1);
});

test('restoreState() stops the active engine', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  await core.restoreState({
    status: 'idle', currentQueueItem: undefined, position: 0, duration: 0, queue: [], policy: [],
  });

  assert.equal(engine.stopCalls, 1);
  assert.equal(core.getState().status, 'idle');
});

test('restoreState() is serialized against an in-flight play()', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' };
    },
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  const core = new CorePlayer();
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  const playPromise = core.play();
  const snapshot = { status: 'idle', currentQueueItem: undefined, position: 7, duration: 0, queue: [], policy: [] };
  const restorePromise = core.restoreState(snapshot);
  await Promise.all([playPromise, restorePromise]);

  // restoreState() only runs after play() has fully finished loading and
  // playing t1 — so it stops the now-active engine and ends up idle with
  // the restored (empty) queue and position, not a hybrid of both calls.
  assert.equal(core.getState().status, 'idle');
  assert.equal(core.getState().position, 7);
  assert.equal(core.getState().queue.length, 0);
  assert.equal(engine.stopCalls, 1);
});

test('restoreState() does not trigger a spurious reconciliation stop during the rebuild', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  // Restoring a snapshot with several items exercises multiple
  // intermediate queue.add() calls (and their 'changed' events) during
  // the rebuild, while the pre-restore #loadedQueueItemId is still (very
  // briefly, before this fix) capable of going stale mid-loop.
  await core.restoreState({
    status: 'idle',
    currentQueueItem: undefined,
    position: 0,
    duration: 0,
    queue: [makeTrack('r1'), makeTrack('r2'), makeTrack('r3')],
    policy: [],
  });

  assert.equal(engine.stopCalls, 1);
  assert.equal(core.getState().queue.length, 3);
});

test('repeat "one": the engine ending naturally replays the same queue item instead of advancing', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.setRepeatMode('one');
  await core.play();

  const beforeItemId = core.getState().currentQueueItem.queueItemId;
  const beforeIndex = core.getState().queue.findIndex((i) => i.queueItemId === beforeItemId);
  const loadCallsBefore = engine.playCalls;

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  const afterItemId = core.getState().currentQueueItem.queueItemId;
  assert.equal(core.getState().queue.findIndex((i) => i.queueItemId === afterItemId), beforeIndex);
  assert.equal(afterItemId, beforeItemId);
  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l1.flac', mime: 'audio/flac' });
  assert.ok(engine.playCalls > loadCallsBefore);
  assert.equal(core.getState().status, 'playing');
});

test('repeat "one" does not block a manual next() from moving to a different track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.setRepeatMode('one');
  await core.play();

  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { kind: 'url', url: 'file:///l2.flac', mime: 'audio/flac' });
});

test('getState reflects shuffle and repeatMode; restoreState round-trips them', async () => {
  const core = new CorePlayer();
  await core.enqueue([makeTrack('t1'), makeTrack('t2')]);
  await core.setShuffle(true);
  await core.setRepeatMode('all');
  const snapshot = core.getState();
  assert.equal(snapshot.shuffle, true);
  assert.equal(snapshot.repeatMode, 'all');

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  const restoredState = restored.getState();
  assert.equal(restoredState.shuffle, true);
  assert.equal(restoredState.repeatMode, 'all');
});

test('restoreState defaults shuffle/repeatMode to false/"off" for a snapshot missing those fields', async () => {
  const core = new CorePlayer();
  await core.enqueue(makeTrack('t1'));
  const snapshot = core.getState();
  delete snapshot.shuffle;
  delete snapshot.repeatMode;

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  const restoredState = restored.getState();
  assert.equal(restoredState.shuffle, false);
  assert.equal(restoredState.repeatMode, 'off');
});

test('repeat "one": if the current item is deselected before "ended" fires, it falls back to normal advance instead of hanging with no current item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.setRepeatMode('one');
  await core.play();

  // Deselecting the current item while leaving both items in the queue
  // (no current item, but getItems().length > 0) is no longer reachable
  // via a direct queue index poke — QueueManager is private to CorePlayer
  // now (see Task 2 of the v0.4 plan). restoreState() with the same items
  // but an undefined currentQueueItem reaches the identical internal
  // state through the public surface instead — this does NOT go through
  // removeFromQueue()'s "item vanished from the queue entirely"
  // reconciliation path (#reconcileMissingCurrentItem), so it still
  // isolates the repeat-one branch's own robustness (it must not blindly
  // call #loadAndPlayCurrent() against an empty current-item) from that
  // unrelated, pre-existing safety net.
  const stateBeforeDeselect = core.getState();
  await core.restoreState({ ...stateBeforeDeselect, currentQueueItem: undefined });
  assert.equal(core.getState().currentQueueItem, undefined);
  assert.equal(core.getState().queue.length, 2);

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  // There's nothing to "repeat" (no current item), so it falls back to
  // ordinary moveNext() behavior — which, from index -1 with items still
  // in the queue, lands on the first item and keeps playing rather than
  // silently hanging at whatever status it was in before 'ended' fired.
  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't1');
});

test('getVolume defaults to 1; setVolume round-trips', () => {
  const core = new CorePlayer();
  assert.equal(core.getVolume(), 1);
  core.setVolume(0.4);
  assert.equal(core.getVolume(), 0.4);
});

test('setVolume(NaN) is a no-op — volume stays at its previous value', () => {
  const core = new CorePlayer();
  core.setVolume(0.4);
  core.setVolume(NaN);
  assert.equal(core.getVolume(), 0.4);
});

test('setVolume(NaN) does not propagate to the active engine', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();
  core.setVolume(0.3);

  core.setVolume(NaN);

  assert.equal(engine.getVolume(), 0.3);
  assert.deepEqual(engine.volumeCalls.at(-1), 0.3);
});

test('setVolume while a track is loaded calls the active engine\'s setVolume immediately', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));
  await core.play();

  core.setVolume(0.3);

  assert.equal(engine.getVolume(), 0.3);
  assert.deepEqual(engine.volumeCalls.at(-1), 0.3);
});

test('a volume set before playback starts is applied to the engine once a track loads', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue(trackWithLocalSource('t1'));

  core.setVolume(0.7);
  assert.equal(engine.volumeCalls.length, 0); // nothing loaded yet, nothing to apply to

  await core.play();

  assert.equal(engine.getVolume(), 0.7);
});

test('volume set on one track carries over when moving to the next track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  core.setVolume(0.2);
  await core.play();

  await core.next();

  assert.equal(engine.getVolume(), 0.2);
});

test('getState reflects volume; restoreState round-trips it', async () => {
  const core = new CorePlayer();
  await core.enqueue(makeTrack('t1'));
  core.setVolume(0.6);
  const snapshot = core.getState();
  assert.equal(snapshot.volume, 0.6);

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  assert.equal(restored.getState().volume, 0.6);
  assert.equal(restored.getVolume(), 0.6);
});

test('restoreState defaults volume to 1 for a snapshot missing that field', async () => {
  const core = new CorePlayer();
  await core.enqueue(makeTrack('t1'));
  const snapshot = core.getState();
  delete snapshot.volume;

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  assert.equal(restored.getState().volume, 1);
});

// --- v0.2.0 plugin lifecycle -----------------------------------------------

test('play() throws PluginsNotInitializedError before initializePlugins() has been awaited', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(createMockPlaybackEngine({ id: 'web-audio' }));
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue(trackWithLocalSource('t1'));

  await assert.rejects(() => core.play(), (err) => {
    assert.ok(err instanceof PluginsNotInitializedError);
    return true;
  });
});

test('initializePlugins() calls initialize() on every registered source provider and playback engine', async () => {
  const core = new CorePlayer();
  const initCalls = [];
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  provider.initialize = async (ctx) => { initCalls.push(['provider', ctx]); };
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.initialize = async (ctx) => { initCalls.push(['engine', ctx]); };
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);

  const host = { platform: /** @type {const} */ ('electron'), version: '31.0.0' };
  await core.initializePlugins({ host, config: { foo: 'bar' } });

  assert.equal(initCalls.length, 2);
  assert.deepEqual(initCalls.map((c) => c[0]).sort(), ['engine', 'provider']);
  for (const [, ctx] of initCalls) {
    assert.deepEqual(ctx.host, host);
    assert.deepEqual(ctx.config, { foo: 'bar' });
    assert.equal(typeof ctx.log, 'function');
  }
});

test('dispose() calls dispose() on every registered source provider and playback engine, then play() requires re-initialization', async () => {
  const core = new CorePlayer();
  const disposeCalls = [];
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  provider.dispose = async () => { disposeCalls.push('provider'); };
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.dispose = async () => { disposeCalls.push('engine'); };
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue(trackWithLocalSource('t1'));

  await core.initializePlugins({});
  await core.play();
  await core.dispose();

  assert.deepEqual(disposeCalls.sort(), ['engine', 'provider']);
  await assert.rejects(() => core.play(), PluginsNotInitializedError);
});

// --- v0.4.0 lookaheadPlayback (revisioned lookahead plan) -------------------

test('a lookaheadPlayback engine receives a revisioned lookahead plan via setPlaybackPlan instead of load()', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue([
    trackWithLocalSource('t1', 'l1'),
    trackWithLocalSource('t2', 'l2'),
    trackWithLocalSource('t3', 'l3'),
    trackWithLocalSource('t4', 'l4'),
  ]);
  await core.initializePlugins({});

  await core.play();

  assert.equal(engine.loaded, null, 'load() is never called for a lookaheadPlayback engine');
  assert.equal(engine.playCalls, 1);
  assert.deepEqual(engine.plan.map((p) => p.resolved.url), [
    'file:///l1.flac', 'file:///l2.flac', 'file:///l3.flac',
  ]);
  assert.equal(typeof engine.planRevision, 'number');
  assert.equal(core.getState().status, 'playing');
});

test('a lookaheadPlayback engine\'s genuine "ended" (no more plan to hand off to) advances the queue, same as a non-lookahead engine\'s does', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  // Simulates the engine having genuinely exhausted its plan (e.g. it's a
  // real single-track engine that never advertised gapless chaining, or it
  // has reached the true end of a shorter-than-expected window) — Core
  // must not just sit there forever; #advanceOnEnded's normal
  // queue.moveNext() + reload path applies exactly as it would for a
  // non-lookahead engine.
  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.equal(core.getState().status, 'playing');
});

test('a lookaheadPlayback engine\'s "playbackStarted" event reconciles Core\'s queue pointer', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  const [, second] = await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item.track.id));

  engine._simulate('playbackStarted', { queueItemId: second.queueItemId, planRevision: engine.planRevision });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.queueItemId, second.queueItemId);
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.equal(core.getState().status, 'playing');
  assert.deepEqual(trackChanged, ['t2']);
});

test('a "playbackStarted"/"playbackExhausted" event for a stale plan revision is ignored, not applied', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  const [, second] = await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  const staleRevision = engine.planRevision - 1;
  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item.track.id));

  // A report tagged with an older revision than the one Core most recently
  // installed must be silently ignored — not treated as an error, and not
  // applied to Core's queue pointer.
  engine._simulate('playbackStarted', { queueItemId: second.queueItemId, planRevision: staleRevision });
  engine._simulate('playbackExhausted', { queueItemId: second.queueItemId, planRevision: staleRevision });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(trackChanged, []);
  assert.equal(core.getState().status, 'playing');
});

test('queue mutations refresh the lookahead plan of an active lookaheadPlayback engine, installing a new, strictly higher plan revision', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  const planBefore = engine.plan;
  const revisionBefore = engine.planRevision;
  await core.enqueue(trackWithLocalSource('t3', 'l3'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(engine.plan, planBefore);
  assert.ok(engine.planRevision > revisionBefore, 'a queue mutation installs a new, strictly higher plan revision');
  assert.deepEqual(engine.plan.map((p) => p.queueItemId), core.getState().queue.map((i) => i.queueItemId));
});

test('repeat: "one" pads a lookaheadPlayback engine\'s lookahead plan with the current item instead of the actual next queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.setRepeatMode('one');
  const [first] = await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});

  await core.play();

  // Without repeat-mode awareness, a lookaheadPlayback engine would have
  // pre-buffered t2 as "next" (the actual next queue item) and would
  // auto-advance into it on its own — bypassing repeat: 'one' entirely.
  // Every entry in the plan should instead be the current item, so the
  // engine's own internal auto-advance just replays it.
  assert.equal(engine.plan.length, 3);
  assert.ok(engine.plan.every((p) => p.queueItemId === first.queueItemId));
});

test('a lookahead entry that fails to resolve is omitted from the plan without aborting playback of the current track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => {
      if (ref.token.token === 'l2') throw new Error('l2 is temporarily unavailable');
      return { kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' };
    },
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, lookaheadPlayback: true },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2'), trackWithLocalSource('t3', 'l3')]);
  await core.initializePlugins({});

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  // t2's lookahead resolve failure is non-fatal: the current track (t1)
  // still starts normally, no 'error' event fires for it, and the failing
  // entry is simply missing from the plan handed to the engine — t3
  // resolves fine and is still included.
  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(errors, []);
  assert.deepEqual(engine.plan.map((p) => p.queueItemId), [
    core.getState().queue[0].queueItemId,
    core.getState().queue[2].queueItemId,
  ]);
});

test('dispose() detaches every listener #bindEngine ever attached, via engine.off()', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ kind: 'url', url: `file:///${ref.token.token}.flac`, mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.enqueue(trackWithLocalSource('t1', 'l1'));
  await core.initializePlugins({});
  await core.play();

  assert.ok(engine._listenerCount('progress') > 0);
  assert.ok(engine._listenerCount('ended') > 0);
  assert.ok(engine._listenerCount('error') > 0);

  await core.dispose();

  assert.equal(engine._listenerCount('progress'), 0);
  assert.equal(engine._listenerCount('ended'), 0);
  assert.equal(engine._listenerCount('error'), 0);
});

test('inspectSourceAvailability reports "providerMissing" when no provider is registered for a queue item\'s source', async () => {
  const core = new CorePlayer();
  const [item] = await core.enqueue(trackWithLocalSource('t1', 'l1'));

  const result = await core.inspectSourceAvailability(item.queueItemId);

  // Redacted: pluginId + the token's own displayPath — never the raw
  // token value ('l1').
  assert.deepEqual(result, {
    queueItemId: item.queueItemId,
    sources: [{ pluginId: 'local-fs', displayPath: undefined, status: 'providerMissing' }],
  });
});

test('inspectSourceAvailability reports "unchecked" for a registered provider that does not require revalidation', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
    capabilities: { offline: true, requiresRevalidation: false },
  });
  core.registerSourceProvider(provider);
  const [item] = await core.enqueue(trackWithLocalSource('t1', 'l1'));

  const result = await core.inspectSourceAvailability(item.queueItemId);

  assert.deepEqual(result, {
    queueItemId: item.queueItemId,
    sources: [{ pluginId: 'local-fs', displayPath: undefined, status: 'unchecked' }],
  });
});

test('inspectSourceAvailability reports "available" when a requiresRevalidation provider\'s revalidate() reports valid: true', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'subsonic', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://example/track', mime: 'audio/flac' }),
    capabilities: { offline: false, requiresRevalidation: true },
    revalidateImpl: async (token) => ({ valid: true, token }),
  });
  core.registerSourceProvider(provider);
  const [item] = await core.enqueue(makeTrack('t1', [
    { pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 's1' }, kind: 'streaming' },
  ]));

  const result = await core.inspectSourceAvailability(item.queueItemId);

  assert.deepEqual(result, {
    queueItemId: item.queueItemId,
    sources: [{ pluginId: 'subsonic', displayPath: undefined, status: 'available' }],
  });
});

test('inspectSourceAvailability reports "invalid" with the provider\'s reason when a requiresRevalidation provider\'s revalidate() reports valid: false', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'subsonic', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://example/track', mime: 'audio/flac' }),
    capabilities: { offline: false, requiresRevalidation: true },
    revalidateImpl: async () => ({ valid: false, reason: 'no longer authorized' }),
  });
  core.registerSourceProvider(provider);
  const [item] = await core.enqueue(makeTrack('t1', [
    { pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 's1' }, kind: 'streaming' },
  ]));

  const result = await core.inspectSourceAvailability(item.queueItemId);

  assert.deepEqual(result, {
    queueItemId: item.queueItemId,
    sources: [{ pluginId: 'subsonic', displayPath: undefined, status: 'invalid', reason: 'no longer authorized' }],
  });
});

test('inspectSourceAvailability reports "unchecked" — not a thrown error out of inspectSourceAvailability itself — when a requiresRevalidation provider\'s revalidate() call throws', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'subsonic', kind: 'streaming',
    resolveImpl: async () => ({ kind: 'url', url: 'https://example/track', mime: 'audio/flac' }),
    capabilities: { offline: false, requiresRevalidation: true },
    // Simulates "revalidate support unavailable right now" (e.g. offline,
    // server unreachable) rather than a definitive valid/invalid answer —
    // this is the "revalidation call itself throws/rejects" branch of
    // 'unchecked', distinct from the requiresRevalidation: false branch
    // covered above.
    revalidateImpl: async () => { throw new Error('network unreachable'); },
  });
  core.registerSourceProvider(provider);
  const [item] = await core.enqueue(makeTrack('t1', [
    { pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 's1' }, kind: 'streaming' },
  ]));

  const result = await core.inspectSourceAvailability(item.queueItemId);

  assert.deepEqual(result, {
    queueItemId: item.queueItemId,
    sources: [{ pluginId: 'subsonic', displayPath: undefined, status: 'unchecked' }],
  });
});

test('inspectSourceAvailability returns an empty sources array for a queueItemId that no longer exists in the queue', async () => {
  const core = new CorePlayer();
  const result = await core.inspectSourceAvailability('missing-item');
  assert.deepEqual(result, { queueItemId: 'missing-item', sources: [] });
});
