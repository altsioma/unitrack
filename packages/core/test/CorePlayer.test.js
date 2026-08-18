import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorePlayer, PluginsNotInitializedError } from '../src/CorePlayer.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('registerSourceProvider delegates to the internal registry (duplicate id throws)', () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ url: 'x' }) });
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
  assert.doesNotThrow(() => core.registerMetadataProvider({ id: 'mb', search: async () => [] }));
  assert.doesNotThrow(() => core.registerPlaylistProvider({ id: 'local', fetchPlaylist: async () => [] }));
});

test('queue mutations emit queueChanged on the core instance', () => {
  const core = new CorePlayer();
  let fired = 0;
  core.on('queueChanged', () => { fired += 1; });
  core.queue.add(makeTrack('t1'));
  assert.equal(fired, 1);
});

test('getState reflects the queue, policy, and default idle status', async () => {
  const core = new CorePlayer();
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(makeTrack('t1'));
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
  core.queue.add([makeTrack('t1'), makeTrack('t2')]);
  core.queue.setCurrentIndex(1);
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
  core.queue.add(makeTrack('t1'));
  const snapshot = core.getState();

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  assert.equal(restored.getState().currentQueueItem, undefined);
});

function trackWithLocalSource(id, sourceId = `${id}-src`) {
  return makeTrack(id, [{ pluginId: 'local-fs', sourceId, kind: 'local' }]);
}

test('play resolves the current track and starts the engine', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item));

  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.deepEqual(engine.loaded, { url: 'file:///a.flac' });
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
  core.queue.add(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].trackId, 't1');
  assert.deepEqual(errors[0].failedSources, [
    { pluginId: 'local-fs', sourceId: 't1-src', reason: 'file missing' },
  ]);
});

test('play emits an error when no registered engine can play the resolved source', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio', canPlayImpl: () => false });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    canPlayImpl: () => { throw new Error('codec probe failed'); },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { url: 'file:///l2.flac' });
});

test('next is a no-op at the end of the queue', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

  await core.play();
  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.equal(engine.playCalls, 1);
});

test('prev loads and plays the preceding queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();
  await core.prev();

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(engine.loaded, { url: 'file:///l1.flac' });
});

test('seek delegates to the active engine only once a track is loaded', async () => {
  const core = new CorePlayer();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerPlaybackEngine(engine);

  await core.seek(30);
  assert.deepEqual(engine.seekCalls, []);

  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  core.registerSourceProvider(provider);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();
  await core.seek(30);
  assert.deepEqual(engine.seekCalls, [30]);
});

test('engine progress events emit a throttled positionChanged', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
});

test('engine ended event sets status to idle when the queue is finished', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
});

test('engine error event during playback stops and emits error', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
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
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  const playPromise = core.play();
  await new Promise((resolve) => setImmediate(resolve));
  engine._simulate('error', new Error('transient'));
  releaseLoad();
  await playPromise;

  assert.equal(core.getState().status, 'playing');

  const current = core.getState().currentQueueItem;
  core.queue.remove(current.queueItemId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('an engine load/play failure is caught and surfaced as an error event, not a rejection', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.play = async () => { throw new Error('device busy'); };
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engineA = createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: (resolved) => resolved.url.includes('l1') });
  const engineB = createMockPlaybackEngine({ id: 'engine-b', canPlayImpl: (resolved) => resolved.url.includes('l2') });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engineA);
  core.registerPlaybackEngine(engineB);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

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
      if (ref.sourceId === 'l2') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { url: `file:///${ref.sourceId}.flac` };
    },
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([
    trackWithLocalSource('t1', 'l1'),
    trackWithLocalSource('t2', 'l2'),
    trackWithLocalSource('t3', 'l3'),
  ]);
  await core.play();

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item.track.id));

  await Promise.all([core.next(), core.next()]);

  assert.equal(core.getState().currentQueueItem.track.id, 't3');
  assert.deepEqual(engine.loaded, { url: 'file:///l3.flac' });
  assert.deepEqual(trackChanged, ['t2', 't3']);
});

test('pause() issued during an in-flight play() still ends up paused', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  const current = core.getState().currentQueueItem;
  core.queue.remove(current.queueItemId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('clearing the queue during playback stops playback and returns to idle', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  core.queue.clear();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('reordering the queue during playback does not interrupt it', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  const current = core.getState().currentQueueItem;
  core.queue.reorder(current.queueItemId, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.stopCalls, 0);
});

test('a direct queue.setCurrentIndex() pointer jump does not interrupt playback', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  core.queue.setCurrentIndex(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.stopCalls, 0);
});

test('play() after queue.setCurrentIndex() to a different item while already playing switches to that item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  core.queue.setCurrentIndex(1);
  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { url: 'file:///l2.flac' });
});

test('play() after queue.setCurrentIndex() to a different item while paused loads and plays the new item, not the old one', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();
  await core.pause();

  core.queue.setCurrentIndex(1);
  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { url: 'file:///l2.flac' });
});

test('play() with no queue-item change while already playing stays a no-op (regression guard)', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
      return { url: 'file:///a.flac' };
    },
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  const core = new CorePlayer();
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  core.queue.setRepeatMode('one');
  await core.play();

  const beforeIndex = core.queue.getCurrentIndex();
  const beforeItemId = core.getState().currentQueueItem.queueItemId;
  const loadCallsBefore = engine.playCalls;

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.queue.getCurrentIndex(), beforeIndex);
  assert.equal(core.getState().currentQueueItem.queueItemId, beforeItemId);
  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(engine.loaded, { url: 'file:///l1.flac' });
  assert.ok(engine.playCalls > loadCallsBefore);
  assert.equal(core.getState().status, 'playing');
});

test('repeat "one" does not block a manual next() from moving to a different track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  core.queue.setRepeatMode('one');
  await core.play();

  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { url: 'file:///l2.flac' });
});

test('getState reflects shuffle and repeatMode; restoreState round-trips them', async () => {
  const core = new CorePlayer();
  core.queue.add([makeTrack('t1'), makeTrack('t2')]);
  core.queue.setShuffle(true);
  core.queue.setRepeatMode('all');
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
  core.queue.add(makeTrack('t1'));
  const snapshot = core.getState();
  delete snapshot.shuffle;
  delete snapshot.repeatMode;

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  const restoredState = restored.getState();
  assert.equal(restoredState.shuffle, false);
  assert.equal(restoredState.repeatMode, 'off');
});

test('repeat "one": if setCurrentIndex(-1) clears the current item before "ended" fires, it falls back to normal advance instead of hanging with no current item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  core.queue.setRepeatMode('one');
  await core.play();

  // setCurrentIndex(-1) deselects without removing anything from the
  // queue, so it does NOT go through remove()'s "item vanished from the
  // queue entirely" reconciliation path (#reconcileMissingCurrentItem) —
  // both items are still present in getItems(), just nothing is
  // "current" anymore. This isolates the repeat-one branch's own
  // robustness (it must not blindly call #loadAndPlayCurrent() against
  // an empty current-item) from that unrelated, pre-existing safety net.
  core.queue.setCurrentIndex(-1);
  assert.equal(core.queue.getCurrentItem(), undefined);

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  core.setVolume(0.3);

  assert.equal(engine.getVolume(), 0.3);
  assert.deepEqual(engine.volumeCalls.at(-1), 0.3);
});

test('a volume set before playback starts is applied to the engine once a track loads', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add(trackWithLocalSource('t1'));

  core.setVolume(0.7);
  assert.equal(engine.volumeCalls.length, 0); // nothing loaded yet, nothing to apply to

  await core.play();

  assert.equal(engine.getVolume(), 0.7);
});

test('volume set on one track carries over when moving to the next track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  await core.initializePlugins({});
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  core.setVolume(0.2);
  await core.play();

  await core.next();

  assert.equal(engine.getVolume(), 0.2);
});

test('getState reflects volume; restoreState round-trips it', async () => {
  const core = new CorePlayer();
  core.queue.add(makeTrack('t1'));
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
  core.queue.add(makeTrack('t1'));
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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(createMockPlaybackEngine({ id: 'web-audio' }));
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
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
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  provider.dispose = async () => { disposeCalls.push('provider'); };
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.dispose = async () => { disposeCalls.push('engine'); };
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  await core.initializePlugins({});
  await core.play();
  await core.dispose();

  assert.deepEqual(disposeCalls.sort(), ['engine', 'provider']);
  await assert.rejects(() => core.play(), PluginsNotInitializedError);
});

// --- v0.2.0 queueAuthority: 'engine' (lookahead plan) ----------------------

test('a queueAuthority: "engine" engine receives a lookahead plan via setPlaybackPlan instead of load()', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, queueAuthority: 'engine' },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([
    trackWithLocalSource('t1', 'l1'),
    trackWithLocalSource('t2', 'l2'),
    trackWithLocalSource('t3', 'l3'),
    trackWithLocalSource('t4', 'l4'),
  ]);
  await core.initializePlugins({});

  await core.play();

  assert.equal(engine.loaded, null, 'load() is never called for a queueAuthority: engine engine');
  assert.equal(engine.playCalls, 1);
  assert.deepEqual(engine.plan.map((p) => p.resolved.url), [
    'file:///l1.flac', 'file:///l2.flac', 'file:///l3.flac',
  ]);
  assert.equal(core.getState().status, 'playing');
});

test('a queueAuthority: "engine" engine\'s "ended" event is ignored — Core waits for "trackChanged" instead', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, queueAuthority: 'engine' },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.track.id, 't1', 'no core-driven advance happened');
  assert.equal(core.getState().status, 'playing');
});

test('a queueAuthority: "engine" engine\'s "trackChanged" event reconciles Core\'s queue pointer', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, queueAuthority: 'engine' },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  const [, second] = core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item.track.id));

  engine._simulate('trackChanged', { queueItemId: second.queueItemId });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.queue.getCurrentIndex(), 1);
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.equal(core.getState().status, 'playing');
  assert.deepEqual(trackChanged, ['t2']);
});

test('queue mutations refresh the lookahead plan of an active queueAuthority: "engine" engine', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({
    id: 'gapless-engine',
    capabilities: { gapless: true, backgroundPlayback: true, queueAuthority: 'engine' },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.initializePlugins({});
  await core.play();

  const planBefore = engine.plan;
  core.queue.add(trackWithLocalSource('t3', 'l3'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(engine.plan, planBefore);
  assert.deepEqual(engine.plan.map((p) => p.queueItemId), core.queue.getItems().map((i) => i.queueItemId));
});
