import {
  CONTRACT_VERSION,
  SOURCE_PROVIDER_CAPABILITY_KEYS,
  PLAYBACK_ENGINE_CAPABILITY_KEYS,
} from './types.js';

/**
 * Thrown by registerX() when a plugin's declared contractVersion doesn't
 * match CONTRACT_VERSION, or its capabilities object has a key outside
 * the closed list this contract version knows about. Catches a
 * malformed or contract-version-mismatched plugin at registration time
 * instead of it silently misbehaving the first time Core calls a method
 * it assumed existed.
 * @extends {Error}
 */
export class PluginContractError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PluginContractError';
  }
}

/**
 * @param {string} pluginId
 * @param {string | undefined} contractVersion
 * @returns {void}
 */
function assertContractVersion(pluginId, contractVersion) {
  if (contractVersion !== CONTRACT_VERSION) {
    throw new PluginContractError(
      `Plugin "${pluginId}" declares contractVersion "${contractVersion}", but this host runs contract ${CONTRACT_VERSION}`
    );
  }
}

// Every capability key across both closed lists is a boolean today — the
// same primitive-type assumption assertCapabilityShape() below checks for
// every key, required or merely allowed-if-present.
const REQUIRED_SOURCE_PROVIDER_CAPABILITY_KEYS = ['offline', 'requiresRevalidation'];
// nowPlaying is deliberately excluded — it's optional on
// PlaybackEngineCapabilities (see types.js), so its absence is not a
// contract violation. Step 3 below still requires setNowPlaying() to exist
// whenever a plugin opts in by declaring nowPlaying: true.
const REQUIRED_PLAYBACK_ENGINE_CAPABILITY_KEYS = ['gapless', 'backgroundPlayback', 'lookaheadPlayback'];

const SOURCE_PROVIDER_REQUIRED_METHODS = ['canResolve', 'resolve', 'revalidate'];
const PLAYBACK_ENGINE_REQUIRED_METHODS = ['canPlay', 'load', 'play', 'pause', 'stop', 'seek', 'getState', 'on', 'off', 'setVolume', 'getVolume'];
const METADATA_PROVIDER_REQUIRED_METHODS = ['search'];
const PLAYLIST_PROVIDER_REQUIRED_METHODS = ['fetchPlaylist'];

/**
 * Checks a capabilities object against a closed allowed-keys list (as
 * before — reject anything outside it) and now also: every key in
 * requiredKeys is present, and every key that IS present (required or
 * merely allowed) has the correct primitive type. Catches both "missing
 * key" and "wrong type" at registration time, rather than a host later
 * getting `undefined` or a non-boolean where it branches on a capability
 * flag.
 * @param {string} pluginId
 * @param {Record<string, unknown> | undefined} capabilities
 * @param {string[]} allowedKeys
 * @param {string[]} requiredKeys
 * @returns {void}
 */
function assertCapabilityShape(pluginId, capabilities, allowedKeys, requiredKeys) {
  const caps = capabilities ?? {};
  for (const key of Object.keys(caps)) {
    if (!allowedKeys.includes(key)) {
      throw new PluginContractError(
        `Plugin "${pluginId}" declares unknown capability "${key}" (contract ${CONTRACT_VERSION} allows: ${allowedKeys.join(', ')})`
      );
    }
  }
  for (const key of requiredKeys) {
    if (!(key in caps)) {
      throw new PluginContractError(
        `Plugin "${pluginId}" is missing required capability "${key}" (contract ${CONTRACT_VERSION} requires: ${requiredKeys.join(', ')})`
      );
    }
  }
  for (const key of allowedKeys) {
    if (key in caps && typeof caps[key] !== 'boolean') {
      throw new PluginContractError(
        `Plugin "${pluginId}" capability "${key}" must be a boolean, got ${typeof caps[key]}`
      );
    }
  }
}

/**
 * @param {string} pluginId
 * @param {Record<string, unknown> | null | undefined} plugin
 * @param {string[]} methods
 * @returns {void}
 */
function assertRequiredMethods(pluginId, plugin, methods) {
  for (const method of methods) {
    if (typeof plugin?.[method] !== 'function') {
      throw new PluginContractError(`Plugin "${pluginId}" is missing required method "${method}"`);
    }
  }
}

export class PluginRegistry {
  /** @type {Map<string, import('./types.js').SourceProvider>} */
  #sourceProviders = new Map();
  /** @type {import('./types.js').PlaybackEngine[]} */
  #playbackEngines = [];
  /** @type {Map<string, import('./types.js').MetadataProvider>} */
  #metadataProviders = new Map();
  /** @type {Map<string, import('./types.js').PlaylistProvider>} */
  #playlistProviders = new Map();

  /**
   * @param {import('./types.js').SourceProvider} plugin
   * @returns {void}
   */
  registerSourceProvider(plugin) {
    if (this.#sourceProviders.has(plugin.id)) {
      throw new Error(`Source provider already registered: ${plugin.id}`);
    }
    assertContractVersion(plugin.id, plugin.contractVersion);
    assertCapabilityShape(plugin.id, plugin.capabilities, SOURCE_PROVIDER_CAPABILITY_KEYS, REQUIRED_SOURCE_PROVIDER_CAPABILITY_KEYS);
    assertRequiredMethods(plugin.id, /** @type {any} */ (plugin), SOURCE_PROVIDER_REQUIRED_METHODS);
    this.#sourceProviders.set(plugin.id, plugin);
  }

  /** @param {string} id @returns {import('./types.js').SourceProvider | undefined} */
  getSourceProvider(id) {
    return this.#sourceProviders.get(id);
  }

  /** @returns {import('./types.js').SourceProvider[]} */
  getSourceProviders() {
    return Array.from(this.#sourceProviders.values());
  }

  /**
   * @param {import('./types.js').PlaybackEngine} plugin
   * @returns {void}
   */
  registerPlaybackEngine(plugin) {
    if (this.#playbackEngines.some((e) => e.id === plugin.id)) {
      throw new Error(`Playback engine already registered: ${plugin.id}`);
    }
    assertContractVersion(plugin.id, plugin.contractVersion);
    assertCapabilityShape(plugin.id, plugin.capabilities, PLAYBACK_ENGINE_CAPABILITY_KEYS, REQUIRED_PLAYBACK_ENGINE_CAPABILITY_KEYS);
    assertRequiredMethods(plugin.id, /** @type {any} */ (plugin), PLAYBACK_ENGINE_REQUIRED_METHODS);
    if (plugin.capabilities.lookaheadPlayback === true && typeof (/** @type {any} */ (plugin)).setPlaybackPlan !== 'function') {
      throw new PluginContractError(
        `Plugin "${plugin.id}" declares capabilities.lookaheadPlayback: true but does not implement setPlaybackPlan`
      );
    }
    if (plugin.capabilities.nowPlaying === true && typeof (/** @type {any} */ (plugin)).setNowPlaying !== 'function') {
      throw new PluginContractError(
        `Plugin "${plugin.id}" declares capabilities.nowPlaying: true but does not implement setNowPlaying`
      );
    }
    this.#playbackEngines.push(plugin);
  }

  /**
   * @param {import('./types.js').ResolvedSource} resolved
   * @returns {Promise<import('./types.js').PlaybackEngine | undefined>}
   */
  async getPlaybackEngineFor(resolved) {
    for (const engine of this.#playbackEngines) {
      if (await engine.canPlay(resolved)) return engine;
    }
    return undefined;
  }

  /** @returns {import('./types.js').PlaybackEngine[]} */
  getPlaybackEngines() {
    return [...this.#playbackEngines];
  }

  /**
   * @param {import('./types.js').MetadataProvider} plugin
   * @returns {void}
   */
  registerMetadataProvider(plugin) {
    if (this.#metadataProviders.has(plugin.id)) {
      throw new Error(`Metadata provider already registered: ${plugin.id}`);
    }
    assertContractVersion(plugin.id, plugin.contractVersion);
    assertRequiredMethods(plugin.id, /** @type {any} */ (plugin), METADATA_PROVIDER_REQUIRED_METHODS);
    this.#metadataProviders.set(plugin.id, plugin);
  }

  /** @param {string} id @returns {import('./types.js').MetadataProvider | undefined} */
  getMetadataProvider(id) {
    return this.#metadataProviders.get(id);
  }

  /** @returns {import('./types.js').MetadataProvider[]} */
  getMetadataProviders() {
    return Array.from(this.#metadataProviders.values());
  }

  /**
   * @param {import('./types.js').PlaylistProvider} plugin
   * @returns {void}
   */
  registerPlaylistProvider(plugin) {
    if (this.#playlistProviders.has(plugin.id)) {
      throw new Error(`Playlist provider already registered: ${plugin.id}`);
    }
    assertContractVersion(plugin.id, plugin.contractVersion);
    assertRequiredMethods(plugin.id, /** @type {any} */ (plugin), PLAYLIST_PROVIDER_REQUIRED_METHODS);
    this.#playlistProviders.set(plugin.id, plugin);
  }

  /** @param {string} id @returns {import('./types.js').PlaylistProvider | undefined} */
  getPlaylistProvider(id) {
    return this.#playlistProviders.get(id);
  }

  /** @returns {import('./types.js').PlaylistProvider[]} */
  getPlaylistProviders() {
    return Array.from(this.#playlistProviders.values());
  }
}
