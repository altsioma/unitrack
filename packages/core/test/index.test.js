import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorePlayer, TrackResolutionError, PluginsNotInitializedError, PluginContractError, CONTRACT_VERSION } from '../src/index.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('the public entry point exports a working CorePlayer', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(makeTrack('t1', [{ pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' }]));

  await core.initializePlugins({});
  await core.play();

  assert.equal(core.getState().status, 'playing');
});

test('the public entry point exports TrackResolutionError', () => {
  const err = new TrackResolutionError('t1', []);
  assert.ok(err instanceof Error);
  assert.equal(err.trackId, 't1');
});

test('the public entry point exports PluginsNotInitializedError', async () => {
  const core = new CorePlayer();
  await assert.rejects(() => core.play(), (err) => {
    assert.ok(err instanceof PluginsNotInitializedError);
    return true;
  });
});

test('the public entry point exports PluginContractError', () => {
  const err = new PluginContractError('bad contract');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'PluginContractError');
});

test('the public entry point exports CONTRACT_VERSION as a string', () => {
  assert.equal(typeof CONTRACT_VERSION, 'string');
  assert.ok(CONTRACT_VERSION.length > 0);
});
