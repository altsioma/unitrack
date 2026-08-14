import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorePlayer } from '../src/CorePlayer.js';
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

test('getState reflects the queue, policy, and default idle status', () => {
  const core = new CorePlayer();
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(makeTrack('t1'));
  const state = core.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.queue.length, 1);
  assert.deepEqual(state.policy, [{ kind: 'local' }]);
  assert.equal(state.currentQueueItem, undefined);
  assert.equal(state.position, 0);
  assert.equal(state.duration, 0);
});

test('restoreState rebuilds the queue in order and preserves the current item', () => {
  const core = new CorePlayer();
  core.queue.add([makeTrack('t1'), makeTrack('t2')]);
  core.queue.setCurrentIndex(1);
  const snapshot = core.getState();

  const restored = new CorePlayer();
  restored.restoreState(snapshot);
  const restoredState = restored.getState();
  assert.equal(restoredState.queue.length, 2);
  assert.equal(restoredState.queue[0].track.id, 't1');
  assert.equal(restoredState.queue[1].track.id, 't2');
  assert.equal(restoredState.currentQueueItem.track.id, 't2');
  assert.deepEqual(restoredState.policy, snapshot.policy);
  assert.equal(restoredState.status, 'idle');
});

test('restoreState with no current item leaves the queue unselected', () => {
  const core = new CorePlayer();
  core.queue.add(makeTrack('t1'));
  const snapshot = core.getState();

  const restored = new CorePlayer();
  restored.restoreState(snapshot);
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
  core.queue.add(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(core.getState().status, 'error');
  assert.equal(errors[0].reason, 'no playback engine registered for resolved source');
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
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  engine._simulate('error', new Error('device disconnected'));

  assert.equal(core.getState().status, 'error');
  assert.equal(errors[0].reason, 'device disconnected');
  assert.equal(errors[0].trackId, 't1');
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
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  const current = core.getState().currentQueueItem;
  core.queue.reorder(current.queueItemId, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.stopCalls, 0);
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
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  await core.next();

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.equal(engine.stopCalls, 0);
});
