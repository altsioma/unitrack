import { EventEmitter } from './EventEmitter.js';
import { QueueManager } from './Queue.js';
import { PluginRegistry } from './PluginRegistry.js';
import { resolveTrack, TrackResolutionError } from './Resolver.js';

/** @extends {EventEmitter} */
export class CorePlayer extends EventEmitter {
  /** @type {PluginRegistry} */
  #registry = new PluginRegistry();
  /** @type {QueueManager} */
  queue = new QueueManager();
  /** @type {import('./types.js').SourcePolicyRule[]} */
  #policy = [];
  /** @type {import('./types.js').PlayerStatus} */
  #status = 'idle';
  /** @type {number} */
  #position = 0;
  /** @type {number} */
  #duration = 0;
  /** @type {import('./types.js').PlaybackEngine | undefined} */
  #activeEngine;
  /** @type {Set<import('./types.js').PlaybackEngine>} */
  #boundEngines = new Set();

  constructor() {
    super();
    this.queue.on('changed', () => this.emit('queueChanged'));
  }

  /** @param {import('./types.js').SourceProvider} plugin @returns {void} */
  registerSourceProvider(plugin) {
    this.#registry.registerSourceProvider(plugin);
  }

  /** @param {import('./types.js').PlaybackEngine} plugin @returns {void} */
  registerPlaybackEngine(plugin) {
    this.#registry.registerPlaybackEngine(plugin);
  }

  /** @param {import('./types.js').MetadataProvider} plugin @returns {void} */
  registerMetadataProvider(plugin) {
    this.#registry.registerMetadataProvider(plugin);
  }

  /** @param {import('./types.js').PlaylistProvider} plugin @returns {void} */
  registerPlaylistProvider(plugin) {
    this.#registry.registerPlaylistProvider(plugin);
  }

  /** @param {import('./types.js').SourcePolicyRule[]} policyRules @returns {void} */
  setPolicy(policyRules) {
    this.#policy = policyRules;
  }

  /** @returns {import('./types.js').CoreState} */
  getState() {
    return {
      status: this.#status,
      currentQueueItem: this.queue.getCurrentItem(),
      position: this.#position,
      duration: this.#duration,
      queue: this.queue.getItems(),
      policy: this.#policy,
    };
  }

  /** @param {import('./types.js').CoreState} snapshot @returns {void} */
  restoreState(snapshot) {
    this.queue.clear();
    for (const item of snapshot.queue ?? []) {
      this.queue.add(item.track);
    }
    const currentQueueItem = snapshot.currentQueueItem;
    const originalIndex = currentQueueItem
      ? snapshot.queue.findIndex((i) => i.queueItemId === currentQueueItem.queueItemId)
      : -1;
    this.queue.setCurrentIndex(originalIndex);
    this.#policy = snapshot.policy ?? [];
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
  }

  /** @returns {Promise<void>} */
  async play() {
    if (this.#status === 'playing') return;
    if (this.#status === 'paused' && this.#activeEngine) {
      await this.#activeEngine.play();
      this.#status = 'playing';
      this.emit('stateChanged');
      return;
    }
    if (this.queue.getCurrentIndex() === -1) {
      if (this.queue.getItems().length === 0) return;
      this.queue.setCurrentIndex(0);
    }
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async pause() {
    if (this.#status !== 'playing' || !this.#activeEngine) return;
    await this.#activeEngine.pause();
    this.#status = 'paused';
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (this.#activeEngine) await this.#activeEngine.stop();
    this.#status = 'idle';
    this.#position = 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async next() {
    const moved = this.queue.moveNext();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async prev() {
    const moved = this.queue.movePrevious();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @param {number} seconds @returns {Promise<void>} */
  async seek(seconds) {
    if (!this.#activeEngine || this.#status === 'idle' || this.#status === 'error') return;
    await this.#activeEngine.seek(seconds);
  }

  /** @returns {Promise<void>} */
  async #loadAndPlayCurrent() {
    const queueItem = this.queue.getCurrentItem();
    if (!queueItem) return;

    this.#status = 'loading';
    this.#position = 0;
    this.emit('stateChanged');

    /** @type {import('./types.js').ResolvedSource} */
    let resolved;
    try {
      resolved = await resolveTrack(queueItem.track, this.#policy, this.#registry.getSourceProviders());
    } catch (err) {
      this.#status = 'error';
      this.emit('error', {
        queueItemId: queueItem.queueItemId,
        trackId: queueItem.track.id,
        reason: err instanceof TrackResolutionError ? 'resolution failed' : (err instanceof Error ? err.message : String(err)),
        failedSources: err instanceof TrackResolutionError ? err.failedSources : [],
      });
      this.emit('stateChanged');
      return;
    }

    const engine = this.#registry.getPlaybackEngineFor(resolved);
    if (!engine) {
      this.#status = 'error';
      this.emit('error', {
        queueItemId: queueItem.queueItemId,
        trackId: queueItem.track.id,
        reason: 'no playback engine registered for resolved source',
        failedSources: [],
      });
      this.emit('stateChanged');
      return;
    }

    this.#bindEngine(engine);
    try {
      await engine.load(resolved);
      await engine.play();
    } catch (err) {
      this.#status = 'error';
      this.emit('error', {
        queueItemId: queueItem.queueItemId,
        trackId: queueItem.track.id,
        reason: err instanceof Error ? err.message : String(err),
        failedSources: [],
      });
      this.emit('stateChanged');
      return;
    }
    this.#status = 'playing';
    this.emit('trackChanged', queueItem);
    this.emit('stateChanged');
  }

  /** @param {import('./types.js').PlaybackEngine} engine @returns {void} */
  #bindEngine(engine) {
    this.#activeEngine = engine;
    if (this.#boundEngines.has(engine)) return;
    this.#boundEngines.add(engine);

    const POSITION_THROTTLE_MS = 250;
    let lastEmit = 0;
    engine.on('progress', ({ position, duration }) => {
      this.#position = position;
      this.#duration = duration;
      const now = Date.now();
      if (now - lastEmit >= POSITION_THROTTLE_MS) {
        lastEmit = now;
        this.emit('positionChanged', { position, duration });
      }
    });

    engine.on('ended', () => {
      const moved = this.queue.moveNext();
      if (moved) {
        this.#loadAndPlayCurrent();
      } else {
        this.#status = 'idle';
        this.emit('stateChanged');
      }
    });

    engine.on('error', (error) => {
      this.#status = 'error';
      const queueItem = this.queue.getCurrentItem();
      this.emit('error', {
        queueItemId: queueItem?.queueItemId,
        trackId: queueItem?.track.id,
        reason: error instanceof Error ? error.message : String(error),
        failedSources: [],
      });
      this.emit('stateChanged');
    });
  }
}
