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
    this.#playbackEngines.push(plugin);
  }

  /**
   * @param {import('./types.js').ResolvedSource} resolved
   * @returns {import('./types.js').PlaybackEngine | undefined}
   */
  getPlaybackEngineFor(resolved) {
    return this.#playbackEngines.find((e) => e.canPlay(resolved));
  }

  /**
   * @param {import('./types.js').MetadataProvider} plugin
   * @returns {void}
   */
  registerMetadataProvider(plugin) {
    if (this.#metadataProviders.has(plugin.id)) {
      throw new Error(`Metadata provider already registered: ${plugin.id}`);
    }
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
