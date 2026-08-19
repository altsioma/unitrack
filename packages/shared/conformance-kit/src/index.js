import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION,
  SOURCE_PROVIDER_CAPABILITY_KEYS,
  PLAYBACK_ENGINE_CAPABILITY_KEYS,
} from '@unitrack/core/types';

// Plain node:assert/strict calls — no dependency on node:test (or any other
// test runner) itself, matching the design spec's "framework-agnostic"
// requirement. Every assertXConformance() function below is just a
// sequence of these; the caller decides how to run it: wrap it in a
// `test()` for a node --test / headless-browser suite (see this package's
// own test/index.test.js for that pattern), or call it directly from an
// in-app developer self-check screen and render the thrown
// AssertionError's .message on failure — nothing here assumes either
// context.

/**
 * @param {import('@unitrack/core/types').PluginContext} [ctx]
 * @returns {import('@unitrack/core/types').PluginContext}
 */
function fallbackContext(ctx) {
  return {
    log: ctx?.log ?? (() => {}),
    config: ctx?.config ?? {},
    host: ctx?.host ?? { platform: 'web', version: '0' },
  };
}

/**
 * @param {string} label
 * @param {Record<string, unknown> | undefined} capabilities
 * @param {string[]} allowedKeys
 * @returns {void}
 */
function assertCapabilityKeysAreClosed(label, capabilities, allowedKeys) {
  assert.ok(capabilities && typeof capabilities === 'object', `${label}: capabilities must be an object`);
  for (const key of Object.keys(capabilities)) {
    assert.ok(
      allowedKeys.includes(key),
      `${label}: capabilities declares unknown key "${key}" (contract ${CONTRACT_VERSION} allows: ${allowedKeys.join(', ')})`
    );
  }
}

/**
 * @param {string} label
 * @param {unknown} plugin
 * @returns {void}
 */
function assertBasePluginShape(label, plugin) {
  assert.ok(plugin && typeof plugin === 'object', `${label}: plugin must be an object`);
  const p = /** @type {Record<string, unknown>} */ (plugin);
  assert.equal(typeof p.id, 'string', `${label}: id must be a string`);
  assert.ok(/** @type {string} */ (p.id).length > 0, `${label}: id must not be empty`);
  assert.equal(
    p.contractVersion, CONTRACT_VERSION,
    `${label}: contractVersion "${p.contractVersion}" does not match this kit's CONTRACT_VERSION "${CONTRACT_VERSION}"`
  );
  assert.equal(typeof p.initialize, 'function', `${label}: initialize must be a function`);
  assert.equal(typeof p.dispose, 'function', `${label}: dispose must be a function`);
}

/**
 * @param {string} label
 * @param {import('@unitrack/core/types').ResolvedSource} resolved
 * @returns {void}
 */
function assertResolvedSourceShape(label, resolved) {
  assert.ok(resolved && typeof resolved === 'object', `${label}: resolved source must be an object`);
  assert.ok(
    ['url', 'stream', 'buffer'].includes(resolved.kind),
    `${label}: resolved.kind must be 'url' | 'stream' | 'buffer', got "${resolved.kind}"`
  );
  assert.equal(typeof resolved.mime, 'string', `${label}: resolved.mime must be a string (use '' or a placeholder like 'application/octet-stream' if genuinely unknown, never omit it)`);
  if (resolved.kind === 'url') {
    assert.equal(typeof resolved.url, 'string', `${label}: resolved.url must be a string when kind === 'url'`);
    assert.ok(/** @type {string} */ (resolved.url).length > 0, `${label}: resolved.url must not be empty when kind === 'url'`);
  } else if (resolved.kind === 'stream') {
    assert.ok(resolved.stream !== undefined, `${label}: resolved.stream must be present when kind === 'stream'`);
  } else if (resolved.kind === 'buffer') {
    assert.ok(resolved.buffer instanceof ArrayBuffer, `${label}: resolved.buffer must be an ArrayBuffer when kind === 'buffer'`);
  }
  if (resolved.headers !== undefined) {
    assert.equal(typeof resolved.headers, 'object', `${label}: resolved.headers must be an object when present`);
  }
  if (resolved.bitrate !== undefined) {
    assert.equal(typeof resolved.bitrate, 'number', `${label}: resolved.bitrate must be a number when present`);
  }
}

/**
 * @param {string} label
 * @param {import('@unitrack/core/types').SourceToken} token
 * @returns {void}
 */
function assertSourceTokenShape(label, token) {
  assert.ok(token && typeof token === 'object', `${label}: token must be an object`);
  assert.equal(typeof token.pluginId, 'string', `${label}: token.pluginId must be a string`);
  assert.equal(typeof token.token, 'string', `${label}: token.token must be a string`);
  if (token.displayPath !== undefined) {
    assert.equal(typeof token.displayPath, 'string', `${label}: token.displayPath must be a string when present`);
  }
}

/**
 * Runs a SourceProvider through its full plugin-contract shape, plus a
 * live behavioral check against `sampleRef` — a SourceRef the caller
 * knows this specific provider instance can actually act on (a real file
 * for a filesystem provider, a fixture/mock token for a mock provider).
 * Calls initialize() and dispose() on the provider as part of the run.
 * @param {import('@unitrack/core/types').SourceProvider} provider
 * @param {import('@unitrack/core/types').SourceRef} sampleRef
 * @param {import('@unitrack/core/types').PluginContext} [ctx]
 * @returns {Promise<void>}
 */
export async function assertSourceProviderConformance(provider, sampleRef, ctx) {
  const label = `SourceProvider "${provider?.id}"`;
  assertBasePluginShape(label, provider);
  assert.equal(typeof provider.kind, 'string', `${label}: kind must be a string`);
  assertCapabilityKeysAreClosed(label, provider.capabilities, SOURCE_PROVIDER_CAPABILITY_KEYS);
  assert.equal(typeof provider.capabilities.offline, 'boolean', `${label}: capabilities.offline must be a boolean`);
  assert.equal(typeof provider.capabilities.requiresRevalidation, 'boolean', `${label}: capabilities.requiresRevalidation must be a boolean`);
  assert.equal(typeof provider.canResolve, 'function', `${label}: canResolve must be a function`);
  assert.equal(typeof provider.resolve, 'function', `${label}: resolve must be a function`);
  assert.equal(typeof provider.revalidate, 'function', `${label}: revalidate must be a function`);

  await provider.initialize(fallbackContext(ctx));

  const canResolve = await provider.canResolve(sampleRef);
  assert.equal(typeof canResolve, 'boolean', `${label}: canResolve() must return a boolean`);

  if (canResolve) {
    const resolved = await provider.resolve(sampleRef);
    assertResolvedSourceShape(label, resolved);
  }

  const revalidation = await provider.revalidate(sampleRef.token);
  assert.ok(revalidation && typeof revalidation === 'object', `${label}: revalidate() must return an object`);
  assert.equal(typeof revalidation.valid, 'boolean', `${label}: revalidate() result .valid must be a boolean`);
  if (revalidation.valid) {
    if (revalidation.token !== undefined) assertSourceTokenShape(label, revalidation.token);
  } else if (revalidation.reason !== undefined) {
    assert.equal(typeof revalidation.reason, 'string', `${label}: revalidate() result .reason must be a string when present`);
  }

  await provider.dispose();
}

/**
 * Runs a PlaybackEngine through its full plugin-contract shape, plus a
 * live behavioral check against `sampleResolvedSource` — a ResolvedSource
 * the caller knows this specific engine instance can actually play (or at
 * least evaluate via canPlay()). Calls initialize() and dispose() on the
 * engine as part of the run.
 * @param {import('@unitrack/core/types').PlaybackEngine} engine
 * @param {import('@unitrack/core/types').ResolvedSource} sampleResolvedSource
 * @param {import('@unitrack/core/types').PluginContext} [ctx]
 * @returns {Promise<void>}
 */
export async function assertPlaybackEngineConformance(engine, sampleResolvedSource, ctx) {
  const label = `PlaybackEngine "${engine?.id}"`;
  assertBasePluginShape(label, engine);
  assertCapabilityKeysAreClosed(label, engine.capabilities, PLAYBACK_ENGINE_CAPABILITY_KEYS);
  assert.equal(typeof engine.capabilities.gapless, 'boolean', `${label}: capabilities.gapless must be a boolean`);
  assert.equal(typeof engine.capabilities.backgroundPlayback, 'boolean', `${label}: capabilities.backgroundPlayback must be a boolean`);
  assert.ok(
    engine.capabilities.queueAuthority === 'core' || engine.capabilities.queueAuthority === 'engine',
    `${label}: capabilities.queueAuthority must be 'core' | 'engine'`
  );
  if (engine.capabilities.nowPlaying !== undefined) {
    assert.equal(typeof engine.capabilities.nowPlaying, 'boolean', `${label}: capabilities.nowPlaying must be a boolean when present`);
  }

  const engineRecord = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (engine));
  for (const method of ['canPlay', 'load', 'play', 'pause', 'stop', 'seek', 'getState', 'on', 'off', 'setVolume', 'getVolume']) {
    assert.equal(typeof engineRecord[method], 'function', `${label}: ${method} must be a function`);
  }
  if (engine.capabilities.queueAuthority === 'engine') {
    assert.equal(typeof engine.setPlaybackPlan, 'function', `${label}: setPlaybackPlan must be a function when capabilities.queueAuthority === 'engine'`);
  }
  if (engine.capabilities.nowPlaying) {
    assert.equal(typeof engine.setNowPlaying, 'function', `${label}: setNowPlaying must be a function when capabilities.nowPlaying === true`);
  }

  await engine.initialize(fallbackContext(ctx));

  const canPlay = await engine.canPlay(sampleResolvedSource);
  assert.equal(typeof canPlay, 'boolean', `${label}: canPlay() must return a boolean`);

  // on()/off() round-trip: must not throw for a handler that was never
  // fired, and off() must accept the exact (event, handler) pair on() was
  // given. This does not prove no listener leaked internally — a package's
  // own test suite (with access to its private listener internals or a
  // mock target's _listenerCount()) is the right place for that — it only
  // proves the contract's on/off shape itself is honored.
  const noop = () => {};
  engine.on('error', noop);
  engine.off('error', noop);

  const state = engine.getState();
  assert.ok(state && typeof state === 'object', `${label}: getState() must return an object`);
  assert.equal(typeof state.position, 'number', `${label}: getState().position must be a number`);
  assert.equal(typeof state.duration, 'number', `${label}: getState().duration must be a number`);
  assert.equal(typeof state.buffering, 'boolean', `${label}: getState().buffering must be a boolean`);

  engine.setVolume(0.7);
  assert.equal(typeof engine.getVolume(), 'number', `${label}: getVolume() must return a number`);

  await engine.dispose();
}

/**
 * Runs a MetadataProvider through its plugin-contract shape. Does not call
 * search()/fetchForSource() — their actual behavior varies too much
 * between providers to assert generically (a provider may legitimately
 * always throw from one of them, as @unitrack/metadata-local-fs does from
 * search()) — only that the contract's required shape is present. Calls
 * initialize() and dispose() on the provider as part of the run.
 * @param {import('@unitrack/core/types').MetadataProvider} provider
 * @param {import('@unitrack/core/types').PluginContext} [ctx]
 * @returns {Promise<void>}
 */
export async function assertMetadataProviderConformance(provider, ctx) {
  const label = `MetadataProvider "${provider?.id}"`;
  assertBasePluginShape(label, provider);
  assert.equal(typeof provider.search, 'function', `${label}: search must be a function`);
  if (provider.fetchForSource !== undefined) {
    assert.equal(typeof provider.fetchForSource, 'function', `${label}: fetchForSource must be a function when present`);
  }

  await provider.initialize(fallbackContext(ctx));
  await provider.dispose();
}

/**
 * Runs a PlaylistProvider through its plugin-contract shape, plus (when
 * `samplePlaylistRef` is given) a live fetchPlaylist() call whose result
 * is checked against the LogicalTrack shape. Calls initialize() and
 * dispose() on the provider as part of the run.
 * @param {import('@unitrack/core/types').PlaylistProvider} provider
 * @param {import('@unitrack/core/types').PlaylistRef} [samplePlaylistRef]
 * @param {import('@unitrack/core/types').PluginContext} [ctx]
 * @returns {Promise<void>}
 */
export async function assertPlaylistProviderConformance(provider, samplePlaylistRef, ctx) {
  const label = `PlaylistProvider "${provider?.id}"`;
  assertBasePluginShape(label, provider);
  assert.equal(typeof provider.fetchPlaylist, 'function', `${label}: fetchPlaylist must be a function`);
  if (provider.listPlaylists !== undefined) {
    assert.equal(typeof provider.listPlaylists, 'function', `${label}: listPlaylists must be a function when present`);
  }

  await provider.initialize(fallbackContext(ctx));

  if (samplePlaylistRef) {
    const tracks = await provider.fetchPlaylist(samplePlaylistRef);
    assert.ok(Array.isArray(tracks), `${label}: fetchPlaylist() must return an array`);
    for (const track of tracks) {
      assert.equal(typeof track.id, 'string', `${label}: LogicalTrack.id must be a string`);
      assert.ok(track.metadata && typeof track.metadata === 'object', `${label}: LogicalTrack.metadata must be an object`);
      assert.equal(typeof track.metadata.artist, 'string', `${label}: LogicalTrack.metadata.artist must be a string`);
      assert.equal(typeof track.metadata.album, 'string', `${label}: LogicalTrack.metadata.album must be a string`);
      assert.equal(typeof track.metadata.title, 'string', `${label}: LogicalTrack.metadata.title must be a string`);
      assert.ok(Array.isArray(track.sources), `${label}: LogicalTrack.sources must be an array`);
      for (const ref of track.sources) {
        assert.equal(typeof ref.pluginId, 'string', `${label}: SourceRef.pluginId must be a string`);
        assertSourceTokenShape(label, ref.token);
        assert.equal(typeof ref.kind, 'string', `${label}: SourceRef.kind must be a string`);
      }
    }
  }

  await provider.dispose();
}
