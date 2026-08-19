import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginContractError } from '../src/PluginRegistry.js';
import { CONTRACT_VERSION } from '../src/types.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';

test('registers and looks up a source provider by id', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }) });
  registry.registerSourceProvider(provider);
  assert.equal(registry.getSourceProvider('local-fs'), provider);
  assert.deepEqual(registry.getSourceProviders(), [provider]);
});

test('throws when registering a source provider with a duplicate id', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }) });
  registry.registerSourceProvider(provider);
  assert.throws(() => registry.registerSourceProvider(provider), /already registered/);
});

test('getPlaybackEngineFor returns the first registered engine whose canPlay matches', async () => {
  const registry = new PluginRegistry();
  const noMatch = createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: () => false });
  const match = createMockPlaybackEngine({ id: 'engine-b', canPlayImpl: () => true });
  registry.registerPlaybackEngine(noMatch);
  registry.registerPlaybackEngine(match);
  assert.equal(await registry.getPlaybackEngineFor({ kind: 'url', url: 'x', mime: 'audio/flac' }), match);
});

test('getPlaybackEngineFor returns undefined when no engine matches', async () => {
  const registry = new PluginRegistry();
  registry.registerPlaybackEngine(createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: () => false }));
  assert.equal(await registry.getPlaybackEngineFor({ kind: 'url', url: 'x', mime: 'audio/flac' }), undefined);
});

test('getPlaybackEngines returns every registered engine in registration order', () => {
  const registry = new PluginRegistry();
  const a = createMockPlaybackEngine({ id: 'engine-a' });
  const b = createMockPlaybackEngine({ id: 'engine-b' });
  registry.registerPlaybackEngine(a);
  registry.registerPlaybackEngine(b);
  assert.deepEqual(registry.getPlaybackEngines(), [a, b]);
});

test('throws when registering a playback engine with a duplicate id', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  registry.registerPlaybackEngine(engine);
  assert.throws(() => registry.registerPlaybackEngine(engine), /already registered/);
});

test('registers and looks up a metadata provider by id', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'musicbrainz', contractVersion: CONTRACT_VERSION, search: async () => [] };
  registry.registerMetadataProvider(provider);
  assert.equal(registry.getMetadataProvider('musicbrainz'), provider);
  assert.deepEqual(registry.getMetadataProviders(), [provider]);
});

test('registers and looks up a playlist provider by id', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'local-playlists', contractVersion: CONTRACT_VERSION, fetchPlaylist: async () => [] };
  registry.registerPlaylistProvider(provider);
  assert.equal(registry.getPlaylistProvider('local-playlists'), provider);
  assert.deepEqual(registry.getPlaylistProviders(), [provider]);
});

test('registerSourceProvider throws PluginContractError when contractVersion does not match', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }) });
  provider.contractVersion = '0.2.0';
  assert.throws(() => registry.registerSourceProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /declares contractVersion "0\.2\.0"/);
    return true;
  });
});

test('registerSourceProvider throws PluginContractError when capabilities has an unknown key', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }),
    capabilities: { offline: true, requiresRevalidation: false, madeUp: true },
  });
  assert.throws(() => registry.registerSourceProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /unknown capability "madeUp"/);
    return true;
  });
});

test('registerSourceProvider throws PluginContractError when a required capability key is missing', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }),
    capabilities: /** @type {any} */ ({ offline: true }), // missing requiresRevalidation
  });
  assert.throws(() => registry.registerSourceProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /missing required capability "requiresRevalidation"/);
    return true;
  });
});

test('registerSourceProvider throws PluginContractError when a capability key has the wrong type', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ kind: 'url', url: 'x', mime: 'audio/flac' }),
    capabilities: /** @type {any} */ ({ offline: 'yes', requiresRevalidation: false }),
  });
  assert.throws(() => registry.registerSourceProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /capability "offline" must be a boolean/);
    return true;
  });
});

test('registerSourceProvider throws PluginContractError when a required method is missing', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: /** @type {any} */ (undefined),
  });
  assert.throws(() => registry.registerSourceProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /missing required method "resolve"/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when contractVersion does not match', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.contractVersion = '0.2.0';
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /declares contractVersion "0\.2\.0"/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when capabilities has an unknown key', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    capabilities: { gapless: false, backgroundPlayback: false, lookaheadPlayback: false, madeUp: true },
  });
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /unknown capability "madeUp"/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when a required capability key is missing', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    capabilities: /** @type {any} */ ({ gapless: false, backgroundPlayback: false }), // missing lookaheadPlayback
  });
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /missing required capability "lookaheadPlayback"/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when a capability key has the wrong type', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    capabilities: /** @type {any} */ ({ gapless: 'no', backgroundPlayback: false, lookaheadPlayback: false }),
  });
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /capability "gapless" must be a boolean/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when a required method is missing', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  delete (/** @type {any} */ (engine)).seek;
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /missing required method "seek"/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when lookaheadPlayback: true but setPlaybackPlan is missing', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({
    id: 'audio-queue',
    capabilities: { gapless: true, backgroundPlayback: false, lookaheadPlayback: true },
  });
  delete (/** @type {any} */ (engine)).setPlaybackPlan;
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /lookaheadPlayback: true but does not implement setPlaybackPlan/);
    return true;
  });
});

test('registerPlaybackEngine throws PluginContractError when nowPlaying: true but setNowPlaying is missing', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    capabilities: { gapless: false, backgroundPlayback: false, lookaheadPlayback: false, nowPlaying: true },
  });
  assert.throws(() => registry.registerPlaybackEngine(engine), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /nowPlaying: true but does not implement setNowPlaying/);
    return true;
  });
});

test('registerMetadataProvider throws PluginContractError when contractVersion does not match', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'musicbrainz', contractVersion: '0.2.0', search: async () => [] };
  assert.throws(() => registry.registerMetadataProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /declares contractVersion "0\.2\.0"/);
    return true;
  });
});

test('registerPlaylistProvider throws PluginContractError when contractVersion does not match', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'local-playlists', contractVersion: '0.2.0', fetchPlaylist: async () => [] };
  assert.throws(() => registry.registerPlaylistProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /declares contractVersion "0\.2\.0"/);
    return true;
  });
});

test('registerMetadataProvider throws PluginContractError when the required search method is missing', () => {
  const registry = new PluginRegistry();
  const provider = /** @type {any} */ ({ id: 'musicbrainz', contractVersion: CONTRACT_VERSION });
  assert.throws(() => registry.registerMetadataProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /missing required method "search"/);
    return true;
  });
});

test('registerPlaylistProvider throws PluginContractError when the required fetchPlaylist method is missing', () => {
  const registry = new PluginRegistry();
  const provider = /** @type {any} */ ({ id: 'local-playlists', contractVersion: CONTRACT_VERSION });
  assert.throws(() => registry.registerPlaylistProvider(provider), (err) => {
    assert.ok(err instanceof PluginContractError);
    assert.match(err.message, /missing required method "fetchPlaylist"/);
    return true;
  });
});
