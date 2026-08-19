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

/**
 * @param {string} pluginId
 * @param {Record<string, unknown> | undefined} capabilities
 * @param {string[]} allowedKeys
 * @returns {void}
 */
function assertCapabilityShape(pluginId, capabilities, allowedKeys) {
  for (const key of Object.keys(capabilities ?? {})) {
    if (!allowedKeys.includes(key)) {
      throw new PluginContractError(
        `Plugin "${pluginId}" declares unknown capability "${key}" (contract ${CONTRACT_VERSION} allows: ${allowedKeys.join(', ')})`
      );
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
    assertCapabilityShape(plugin.id, plugin.capabilities, SOURCE_PROVIDER_CAPABILITY_KEYS);
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
    assertCapabilityShape(plugin.id, plugin.capabilities, PLAYBACK_ENGINE_CAPABILITY_KEYS);
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
