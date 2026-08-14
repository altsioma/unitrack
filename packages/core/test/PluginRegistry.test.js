import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../src/PluginRegistry.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';

test('registers and looks up a source provider by id', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ url: 'x' }) });
  registry.registerSourceProvider(provider);
  assert.equal(registry.getSourceProvider('local-fs'), provider);
  assert.deepEqual(registry.getSourceProviders(), [provider]);
});

test('throws when registering a source provider with a duplicate id', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ url: 'x' }) });
  registry.registerSourceProvider(provider);
  assert.throws(() => registry.registerSourceProvider(provider), /already registered/);
});

test('getPlaybackEngineFor returns the first registered engine whose canPlay matches', () => {
  const registry = new PluginRegistry();
  const noMatch = createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: () => false });
  const match = createMockPlaybackEngine({ id: 'engine-b', canPlayImpl: () => true });
  registry.registerPlaybackEngine(noMatch);
  registry.registerPlaybackEngine(match);
  assert.equal(registry.getPlaybackEngineFor({ url: 'x' }), match);
});

test('getPlaybackEngineFor returns undefined when no engine matches', () => {
  const registry = new PluginRegistry();
  registry.registerPlaybackEngine(createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: () => false }));
  assert.equal(registry.getPlaybackEngineFor({ url: 'x' }), undefined);
});

test('throws when registering a playback engine with a duplicate id', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  registry.registerPlaybackEngine(engine);
  assert.throws(() => registry.registerPlaybackEngine(engine), /already registered/);
});

test('registers and looks up a metadata provider by id', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'musicbrainz', search: async () => [] };
  registry.registerMetadataProvider(provider);
  assert.equal(registry.getMetadataProvider('musicbrainz'), provider);
  assert.deepEqual(registry.getMetadataProviders(), [provider]);
});

test('registers and looks up a playlist provider by id', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'local-playlists', fetchPlaylist: async () => [] };
  registry.registerPlaylistProvider(provider);
  assert.equal(registry.getPlaylistProvider('local-playlists'), provider);
  assert.deepEqual(registry.getPlaylistProviders(), [provider]);
});
