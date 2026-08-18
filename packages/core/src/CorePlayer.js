import { EventEmitter } from './EventEmitter.js';
import { QueueManager } from './Queue.js';
import { PluginRegistry } from './PluginRegistry.js';
import { resolveTrack, TrackResolutionError } from './Resolver.js';

// How many upcoming queue items (including the current one) get resolved
// and handed to a queueAuthority: 'engine' engine via setPlaybackPlan().
const DEFAULT_LOOKAHEAD_WINDOW = 3;

/**
 * Thrown by play() when initializePlugins() has not yet been awaited —
 * every registered plugin's initialize() must run before Core starts
 * driving playback through it.
 * @extends {Error}
 */
export class PluginsNotInitializedError extends Error {
  constructor() {
    super('CorePlayer.initializePlugins() must be awaited before play()');
    this.name = 'PluginsNotInitializedError';
  }
}

/** @extends {EventEmitter} */
export class CorePlayer extends EventEmitter {
  /** @type {PluginRegistry} */
  #registry = new PluginRegistry();
  /** @type {QueueManager} */
  queue = new QueueManager();
  /** @type {import('./types.js').SourcePolicyRule[]} */
  #policy = [];
  /** @type {number} */
  #volume = 1;
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
  /** @type {boolean} */
  #initialized = false;

  constructor() {
    super();
    this.queue.on('changed', () => {
      this.emit('queueChanged');
      const loadedId = this.#loadedQueueItemId;
      if (loadedId && !this.queue.getItems().some((i) => i.queueItemId === loadedId)) {
        this.#enqueue(() => this.#reconcileMissingCurrentItem(loadedId));
      } else if (loadedId) {
        this.#enqueue(() => this.#refreshLookaheadPlan());
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

  /**
   * Runs initialize(ctx) on every registered SourceProvider and
   * PlaybackEngine, in parallel. Must be awaited before the first play() —
   * play() throws PluginsNotInitializedError otherwise.
   * @param {Partial<import('./types.js').PluginContext>} [hostContext]
   * @returns {Promise<void>}
   */
  async initializePlugins(hostContext = {}) {
    /** @type {import('./types.js').PluginContext} */
    const ctx = {
      log: hostContext.log ?? (() => {}),
      config: hostContext.config ?? {},
      host: hostContext.host ?? { platform: 'web', version: '0' },
    };
    const plugins = [
      ...this.#registry.getSourceProviders(),
      ...this.#registry.getPlaybackEngines(),
    ];
    await Promise.all(plugins.map((plugin) => plugin.initialize(ctx)));
    this.#initialized = true;
  }

  /**
   * Runs dispose() on every registered SourceProvider and PlaybackEngine,
   * in parallel. After this resolves, play() requires initializePlugins()
   * again.
   * @returns {Promise<void>}
   */
  async dispose() {
    const plugins = [
      ...this.#registry.getSourceProviders(),
      ...this.#registry.getPlaybackEngines(),
    ];
    await Promise.all(plugins.map((plugin) => plugin.dispose()));
    this.#initialized = false;
  }

  /** @param {import('./types.js').SourcePolicyRule[]} policyRules @returns {void} */
  setPolicy(policyRules) {
    this.#policy = policyRules;
  }

  /** @param {number} volume @returns {void} */
  setVolume(volume) {
    if (!Number.isFinite(volume)) {
      return;
    }
    this.#volume = Math.max(0, Math.min(1, volume));
    if (this.#activeEngine) {
      this.#activeEngine.setVolume(this.#volume);
    }
  }

  /** @returns {number} */
  getVolume() {
    return this.#volume;
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
      shuffle: this.queue.isShuffleEnabled(),
      repeatMode: this.queue.getRepeatMode(),
      volume: this.#volume,
    };
  }

  /** @param {import('./types.js').CoreState} snapshot @returns {Promise<void>} */
  async restoreState(snapshot) {
    return this.#enqueue(() => this.#restoreState(snapshot));
  }

  /** @param {import('./types.js').CoreState} snapshot @returns {Promise<void>} */
  async #restoreState(snapshot) {
    this.#loadedQueueItemId = undefined;
    if (this.#activeEngine) {
      try {
        await this.#activeEngine.stop();
      } catch (err) {
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.#activeEngine = undefined;

    this.queue.clear();
    for (const item of snapshot.queue ?? []) {
      this.queue.add(item.track);
    }
    const currentQueueItem = snapshot.currentQueueItem;
    const originalIndex = currentQueueItem
      ? snapshot.queue.findIndex((i) => i.queueItemId === currentQueueItem.queueItemId)
      : -1;
    this.queue.setCurrentIndex(originalIndex);
    this.queue.setShuffle(snapshot.shuffle ?? false);
    this.queue.setRepeatMode(snapshot.repeatMode ?? 'off');
    this.#volume = snapshot.volume ?? 1;
    this.#policy = snapshot.policy ?? [];
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async play() {
    if (!this.#initialized) {
      throw new PluginsNotInitializedError();
    }
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
    // The queue's current pointer can move (queue.setCurrentIndex(),
    // clicking a different queue item in a host UI) without going through
    // next()/prev(), which always reload. play() must detect that case —
    // otherwise it treats "playing"/"paused" as "nothing to do" purely
    // from #status, silently resuming/no-op'ing on the stale engine
    // instead of switching to the queue's actual current item.
    const currentItem = this.queue.getCurrentItem();
    const currentItemChanged = currentItem?.queueItemId !== this.#loadedQueueItemId;

    if (this.#status === 'playing' && !currentItemChanged) return;
    if (this.#status === 'paused' && this.#activeEngine && !currentItemChanged) {
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

    /** @type {import('./types.js').PlaybackEngine | undefined} */
    let engine;
    try {
      engine = await this.#registry.getPlaybackEngineFor(resolved);
    } catch (err) {
      this.#emitError(queueItem, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!engine) {
      this.#emitError(queueItem, 'no playback engine registered for resolved source');
      return;
    }

    this.#bindEngine(engine);
    try {
      if (engine.capabilities.queueAuthority === 'engine' && engine.setPlaybackPlan) {
        const plan = await this.#resolveLookaheadPlan(queueItem, resolved);
        await engine.setPlaybackPlan(plan);
      } else {
        await engine.load(resolved);
      }
      await engine.play();
    } catch (err) {
      this.#emitError(queueItem, err instanceof Error ? err.message : String(err));
      return;
    }
    this.#loadedQueueItemId = queueItem.queueItemId;
    this.#status = 'playing';
    this.emit('trackChanged', queueItem);
    this.emit('stateChanged');
  }

  /**
   * Builds the PlaybackPlanEntry[] window handed to a queueAuthority:
   * 'engine' engine's setPlaybackPlan(), starting at the current queue item
   * and resolving up to DEFAULT_LOOKAHEAD_WINDOW items ahead of it.
   *
   * Known limitation: walks queue.getItems() in plain array order, not
   * through QueueManager's shuffle history — there is no non-mutating
   * "peek the next N items" method on QueueManager yet. Acceptable for now
   * since no queueAuthority:'engine' engine exists yet to exercise shuffle
   * interaction; revisit once one does.
   *
   * @param {import('./types.js').QueueItem} currentQueueItem
   * @param {import('./types.js').ResolvedSource} currentResolved
   * @returns {Promise<import('./types.js').PlaybackPlanEntry[]>}
   */
  async #resolveLookaheadPlan(currentQueueItem, currentResolved) {
    /** @type {import('./types.js').PlaybackPlanEntry[]} */
    const plan = [{ queueItemId: currentQueueItem.queueItemId, resolved: currentResolved }];
    const items = this.queue.getItems();
    const currentIdx = items.findIndex((i) => i.queueItemId === currentQueueItem.queueItemId);
    if (currentIdx === -1) return plan;
    const providers = this.#registry.getSourceProviders();
    for (let i = currentIdx + 1; i < items.length && plan.length < DEFAULT_LOOKAHEAD_WINDOW; i += 1) {
      const item = items[i];
      try {
        const resolved = await resolveTrack(item.track, this.#policy, providers);
        plan.push({ queueItemId: item.queueItemId, resolved });
      } catch {
        // A lookahead item that fails to resolve is just omitted from the
        // plan rather than aborting the whole window — normal advancement
        // will surface a real error if playback ever actually reaches it.
      }
    }
    return plan;
  }

  /**
   * Re-resolves and re-pushes the lookahead plan to the active
   * queueAuthority:'engine' engine after the queue changes shape (add,
   * remove, reorder) while that engine still owns the currently-loaded
   * item. A no-op for queueAuthority:'core' engines, or when nothing is
   * currently loaded.
   * @returns {Promise<void>}
   */
  async #refreshLookaheadPlan() {
    if (!this.#activeEngine || this.#activeEngine.capabilities.queueAuthority !== 'engine') return;
    if (!this.#activeEngine.setPlaybackPlan) return;
    const currentQueueItem = this.queue.getCurrentItem();
    if (!currentQueueItem || currentQueueItem.queueItemId !== this.#loadedQueueItemId) return;
    /** @type {import('./types.js').ResolvedSource} */
    let resolved;
    try {
      resolved = await resolveTrack(currentQueueItem.track, this.#policy, this.#registry.getSourceProviders());
    } catch {
      return;
    }
    const plan = await this.#resolveLookaheadPlan(currentQueueItem, resolved);
    try {
      await this.#activeEngine.setPlaybackPlan(plan);
    } catch (err) {
      this.#emitError(currentQueueItem, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Reconciles Core's queue pointer after a queueAuthority:'engine' engine
   * fires 'trackChanged' on its own (e.g. a gapless transition it drove
   * internally via its plan, without Core calling load()/play() again).
   * @param {{ queueItemId?: string }} [payload]
   * @returns {Promise<void>}
   */
  async #reconcileEngineOwnedTrackChange(payload) {
    const newQueueItemId = payload?.queueItemId;
    if (!newQueueItemId) return;
    const items = this.queue.getItems();
    const newIndex = items.findIndex((i) => i.queueItemId === newQueueItemId);
    if (newIndex === -1) return;
    if (newIndex !== this.queue.getCurrentIndex()) {
      this.queue.setCurrentIndex(newIndex);
    }
    this.#loadedQueueItemId = newQueueItemId;
    this.#status = 'playing';
    this.emit('trackChanged', items[newIndex]);
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #advanceOnEnded() {
    if (this.queue.getRepeatMode() === 'one' && this.queue.getCurrentItem()) {
      await this.#loadAndPlayCurrent();
      return;
    }
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
    engine.setVolume(this.#volume);
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

    // queueAuthority: 'engine' engines drive their own queue advancement
    // internally (via the plan handed to setPlaybackPlan) and report it
    // through 'trackChanged' instead of 'ended' — Core reconciles its own
    // queue pointer to match rather than treating every advance as playback
    // finishing. queueAuthority: 'core' engines (the only kind that exists
    // today) keep the original 'ended' -> advance-and-reload behavior.
    if (engine.capabilities.queueAuthority === 'engine') {
      engine.on('trackChanged', (payload) => {
        this.#enqueue(() => this.#reconcileEngineOwnedTrackChange(payload)).catch((err) => {
          this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        });
      });
    } else {
      engine.on('ended', () => {
        this.#enqueue(() => this.#advanceOnEnded()).catch((err) => {
          this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        });
      });
    }

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
