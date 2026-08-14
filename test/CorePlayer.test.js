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
