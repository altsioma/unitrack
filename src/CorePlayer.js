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
  /** @type {Promise<void>} */
  #operationChain = Promise.resolve();
  /** @type {string | undefined} */
  #loadedQueueItemId;

  constructor() {
    super();
    this.queue.on('changed', () => {
      this.emit('queueChanged');
      const loadedId = this.#loadedQueueItemId;
      if (loadedId && !this.queue.getItems().some((i) => i.queueItemId === loadedId)) {
        this.#enqueue(() => this.#reconcileMissingCurrentItem(loadedId));
      }
    });
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
    this.#loadedQueueItemId = undefined;
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
  }

  /** @returns {Promise<void>} */
  async play() {
    return this.#enqueue(() => this.#play());
  }

  /** @returns {Promise<void>} */
  async pause() {
    return this.#enqueue(() => this.#pause());
  }

  /** @returns {Promise<void>} */
  async stop() {
    return this.#enqueue(() => this.#stop());
  }

  /** @returns {Promise<void>} */
  async next() {
    return this.#enqueue(() => this.#next());
  }

  /** @returns {Promise<void>} */
  async prev() {
    return this.#enqueue(() => this.#prev());
  }

  /** @param {number} seconds @returns {Promise<void>} */
  async seek(seconds) {
    return this.#enqueue(() => this.#seek(seconds));
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  #enqueue(operation) {
    const result = this.#operationChain.then(operation, operation);
    this.#operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** @returns {Promise<void>} */
  async #play() {
    if (this.#status === 'playing') return;
    if (this.#status === 'paused' && this.#activeEngine) {
      try {
        await this.#activeEngine.play();
      } catch (err) {
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
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
  async #pause() {
    if (this.#status !== 'playing' || !this.#activeEngine) return;
    try {
      await this.#activeEngine.pause();
    } catch (err) {
      this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
      return;
    }
    this.#status = 'paused';
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #stop() {
    if (this.#activeEngine) {
      try {
        await this.#activeEngine.stop();
      } catch (err) {
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.#loadedQueueItemId = undefined;
    this.#status = 'idle';
    this.#position = 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #next() {
    const moved = this.queue.moveNext();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async #prev() {
    const moved = this.queue.movePrevious();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @param {number} seconds @returns {Promise<void>} */
  async #seek(seconds) {
    if (!this.#activeEngine || this.#status === 'idle' || this.#status === 'error') return;
    try {
      await this.#activeEngine.seek(seconds);
    } catch (err) {
      this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
    }
  }

  /** @returns {Promise<void>} */
  async #loadAndPlayCurrent() {
    const queueItem = this.queue.getCurrentItem();
    if (!queueItem) return;
    this.#loadedQueueItemId = queueItem.queueItemId;

    this.#status = 'loading';
    this.#position = 0;
    this.emit('stateChanged');

    /** @type {import('./types.js').ResolvedSource} */
    let resolved;
    try {
      resolved = await resolveTrack(queueItem.track, this.#policy, this.#registry.getSourceProviders());
    } catch (err) {
      this.#emitError(
        queueItem,
        err instanceof TrackResolutionError ? 'resolution failed' : (err instanceof Error ? err.message : String(err)),
        err instanceof TrackResolutionError ? err.failedSources : []
      );
      return;
    }

    const engine = this.#registry.getPlaybackEngineFor(resolved);
    if (!engine) {
      this.#emitError(queueItem, 'no playback engine registered for resolved source');
      return;
    }

    this.#bindEngine(engine);
    try {
      await engine.load(resolved);
      await engine.play();
    } catch (err) {
      this.#emitError(queueItem, err instanceof Error ? err.message : String(err));
      return;
    }
    this.#status = 'playing';
    this.emit('trackChanged', queueItem);
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #advanceOnEnded() {
    const moved = this.queue.moveNext();
    if (moved) {
      await this.#loadAndPlayCurrent();
    } else {
      this.#loadedQueueItemId = undefined;
      this.#status = 'idle';
      this.emit('stateChanged');
    }
  }

  /**
   * @param {string} missingQueueItemId
   * @returns {Promise<void>}
   */
  async #reconcileMissingCurrentItem(missingQueueItemId) {
    if (this.#loadedQueueItemId !== missingQueueItemId) return;
    if (this.queue.getItems().some((i) => i.queueItemId === missingQueueItemId)) return;
    await this.#stop();
  }

  /** @param {import('./types.js').PlaybackEngine} engine @returns {void} */
  #bindEngine(engine) {
    this.#activeEngine = engine;
    if (this.#boundEngines.has(engine)) return;
    this.#boundEngines.add(engine);

    const POSITION_THROTTLE_MS = 250;
    let lastEmit = 0;
    engine.on('progress', (payload) => {
      const { position = 0, duration = 0 } = payload ?? {};
      this.#position = position;
      this.#duration = duration;
      const now = Date.now();
      if (now - lastEmit >= POSITION_THROTTLE_MS) {
        lastEmit = now;
        this.emit('positionChanged', { position, duration });
      }
    });

    engine.on('ended', () => {
      this.#enqueue(() => this.#advanceOnEnded()).catch((err) => {
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
      });
    });

    engine.on('error', (error) => {
      this.#emitError(this.queue.getCurrentItem(), error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * @param {import('./types.js').QueueItem | undefined} queueItem
   * @param {string} reason
   * @param {Array<{ pluginId: string, sourceId: string, reason: string }>} [failedSources]
   * @returns {void}
   */
  #emitError(queueItem, reason, failedSources = []) {
    this.#loadedQueueItemId = undefined;
    this.#status = 'error';
    this.emit('error', {
      queueItemId: queueItem?.queueItemId,
      trackId: queueItem?.track.id,
      reason,
      failedSources,
    });
    this.emit('stateChanged');
  }
}
