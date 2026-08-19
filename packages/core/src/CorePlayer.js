import { EventEmitter } from './EventEmitter.js';
import { QueueManager } from './Queue.js';
import { PluginRegistry } from './PluginRegistry.js';
import { resolveTrack, TrackResolutionError } from './Resolver.js';

// How many upcoming queue items (including the current one) get resolved
// and handed to a lookaheadPlayback engine via setPlaybackPlan().
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
  /**
   * Private to CorePlayer — QueueManager is never exposed on the public
   * surface. getState().queue remains a snapshot (QueueManager.getItems()
   * already returns a fresh array copy); the seven public queue commands
   * below (enqueue, removeFromQueue, reorderQueueItem, clearQueue,
   * selectQueueItem, setShuffle, setRepeatMode) are the only public way to
   * mutate it. A playback engine may optimise a plan built from this queue
   * (see setPlaybackPlan / PlaybackPlan) but never owns or mutates the
   * queue itself.
   * @type {QueueManager}
   */
  #queue = new QueueManager();
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
  /**
   * Every (event, handler) pair #bindEngine ever attached to a given
   * engine, so dispose() can call engine.off() for each of them —
   * #boundEngines alone only tracked "have we bound this engine," with no
   * way to actually undo it.
   * @type {Map<import('./types.js').PlaybackEngine, Array<[string, (payload?: any) => void]>>}
   */
  #engineListeners = new Map();
  /** @type {Promise<void>} */
  #operationChain = Promise.resolve();
  /** @type {string | undefined} */
  #loadedQueueItemId;
  /** @type {boolean} */
  #initialized = false;
  /**
   * Strictly increasing whenever Core installs, replaces, or invalidates a
   * PlaybackPlan for the active engine (see #resolveLookaheadPlan and its
   * two call sites). A lookaheadPlayback engine's 'playbackStarted'/
   * 'playbackExhausted' events are accepted only when their planRevision
   * matches this counter's current value at the time they're handled —
   * see #handlePlaybackStarted/#handlePlaybackExhausted.
   * @type {number}
   */
  #planRevision = 0;

  constructor() {
    super();
    this.#queue.on('changed', () => {
      this.emit('queueChanged');
      const loadedId = this.#loadedQueueItemId;
      if (loadedId && !this.#queue.getItems().some((i) => i.queueItemId === loadedId)) {
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
   * in parallel, and detaches every listener #bindEngine ever attached
   * (via engine.off()) from every engine it was attached to. After this
   * resolves, play() requires initializePlugins() again, and a
   * previously-bound engine will be freshly re-bound (listeners
   * re-attached) the next time it's used, rather than #bindEngine's
   * already-bound guard silently skipping it.
   * @returns {Promise<void>}
   */
  async dispose() {
    const plugins = [
      ...this.#registry.getSourceProviders(),
      ...this.#registry.getPlaybackEngines(),
    ];
    await Promise.all(plugins.map((plugin) => plugin.dispose()));
    for (const [engine, listeners] of this.#engineListeners) {
      for (const [event, handler] of listeners) {
        engine.off(/** @type {any} */ (event), handler);
      }
    }
    this.#engineListeners.clear();
    this.#boundEngines.clear();
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
      currentQueueItem: this.#queue.getCurrentItem(),
      position: this.#position,
      duration: this.#duration,
      queue: this.#queue.getItems(),
      policy: this.#policy,
      shuffle: this.#queue.isShuffleEnabled(),
      repeatMode: this.#queue.getRepeatMode(),
      volume: this.#volume,
    };
  }

  /**
   * Appends one or more tracks to the end of the canonical queue. The only
   * public way to add to the queue — direct queue mutation is not exposed.
   * Serialized on Core's own operation chain, same as play()/pause()/etc.
   * @param {import('./types.js').LogicalTrack | import('./types.js').LogicalTrack[]} trackOrTracks
   * @returns {Promise<import('./types.js').QueueItem[]>}
   */
  async enqueue(trackOrTracks) {
    return this.#enqueue(() => this.#addToQueue(trackOrTracks));
  }

  /**
   * @param {import('./types.js').LogicalTrack | import('./types.js').LogicalTrack[]} trackOrTracks
   * @returns {Promise<import('./types.js').QueueItem[]>}
   */
  async #addToQueue(trackOrTracks) {
    return this.#queue.add(trackOrTracks);
  }

  /**
   * Removes a single queue item. Queue mutations never interrupt the
   * currently sounding item; they replace only not-yet-started plan
   * entries (see #refreshLookaheadPlan, triggered by the queue's own
   * 'changed' event wired in the constructor).
   * @param {string} queueItemId
   * @returns {Promise<boolean>}
   */
  async removeFromQueue(queueItemId) {
    return this.#enqueue(() => this.#removeFromQueue(queueItemId));
  }

  /** @param {string} queueItemId @returns {Promise<boolean>} */
  async #removeFromQueue(queueItemId) {
    return this.#queue.remove(queueItemId);
  }

  /**
   * @param {string} queueItemId
   * @param {number} index
   * @returns {Promise<boolean>}
   */
  async reorderQueueItem(queueItemId, index) {
    return this.#enqueue(() => this.#reorderQueueItem(queueItemId, index));
  }

  /** @param {string} queueItemId @param {number} index @returns {Promise<boolean>} */
  async #reorderQueueItem(queueItemId, index) {
    return this.#queue.reorder(queueItemId, index);
  }

  /** @returns {Promise<void>} */
  async clearQueue() {
    return this.#enqueue(() => this.#clearQueue());
  }

  /** @returns {Promise<void>} */
  async #clearQueue() {
    this.#queue.clear();
  }

  /**
   * Changes only which queue item is selected — it does not start
   * playback. play() already detects a changed selection
   * (currentItem?.queueItemId !== #loadedQueueItemId) and loads it, same
   * as it always has. Returns false without mutating anything when
   * queueItemId isn't found in the current queue.
   * @param {string} queueItemId
   * @returns {Promise<boolean>}
   */
  async selectQueueItem(queueItemId) {
    return this.#enqueue(() => this.#selectQueueItem(queueItemId));
  }

  /** @param {string} queueItemId @returns {Promise<boolean>} */
  async #selectQueueItem(queueItemId) {
    const idx = this.#queue.getItems().findIndex((i) => i.queueItemId === queueItemId);
    if (idx === -1) return false;
    this.#queue.setCurrentIndex(idx);
    return true;
  }

  /** @param {boolean} enabled @returns {Promise<void>} */
  async setShuffle(enabled) {
    return this.#enqueue(() => this.#setShuffle(enabled));
  }

  /** @param {boolean} enabled @returns {Promise<void>} */
  async #setShuffle(enabled) {
    this.#queue.setShuffle(enabled);
  }

  /** @param {import('./types.js').RepeatMode} mode @returns {Promise<void>} */
  async setRepeatMode(mode) {
    return this.#enqueue(() => this.#setRepeatMode(mode));
  }

  /** @param {import('./types.js').RepeatMode} mode @returns {Promise<void>} */
  async #setRepeatMode(mode) {
    this.#queue.setRepeatMode(mode);
  }

  /**
   * A non-mutating, host-requested assessment of whether each of a queue
   * item's sources currently looks usable — never resolves or plays media,
   * never returns a raw SourceToken.token value (only pluginId and the
   * token's own displayPath), and emits nothing (superseding
   * checkSourceAvailability()'s global 'sourceUnavailable' event — a host
   * that wants to react per-item now does so directly off this method's
   * return value instead).
   *
   * Per source, in order of what was actually checked: 'providerMissing'
   * when no registered provider matches the ref's pluginId at all;
   * otherwise, when the matching provider declares
   * capabilities.requiresRevalidation, a live provider.revalidate(token)
   * call maps { valid: true } to 'available' and { valid: false } to
   * 'invalid' (carrying the provider's own .reason, if it gave one — never
   * the token); otherwise (including when revalidate() itself
   * throws/rejects) 'unchecked' — a registered provider exists, but this
   * call made no live attempt to confirm it will actually resolve.
   *
   * A host can call this proactively — right after restoreState(), for
   * every restored queue item — to flag unplayable items before the user
   * ever presses play, instead of only finding out via an 'error' event
   * during an actual play() attempt. Nothing in CorePlayer calls this on
   * its own; like every other capability-adjacent behavior, surfacing
   * availability eagerly is a host policy choice, not something Core
   * imposes unprompted.
   *
   * A queueItemId that doesn't match any current queue item returns
   * `{ queueItemId, sources: [] }` — an empty-but-well-formed result — the
   * same "nothing to report" shape a real item with a sourceless track
   * would also produce, rather than a sentinel or a thrown error, since a
   * host that already has a queueItemId in hand (e.g. from a state
   * snapshot) shouldn't have to special-case "it might not exist anymore"
   * separately from "it exists but has nothing to check."
   * @param {string} queueItemId
   * @returns {Promise<import('./types.js').SourceAvailabilityResult>}
   */
  async inspectSourceAvailability(queueItemId) {
    const item = this.#queue.getItems().find((i) => i.queueItemId === queueItemId);
    if (!item) return { queueItemId, sources: [] };

    const sources = await Promise.all(item.track.sources.map(async (ref) => {
      const provider = this.#registry.getSourceProvider(ref.pluginId);
      const displayPath = ref.token.displayPath;
      if (!provider) {
        return { pluginId: ref.pluginId, displayPath, status: /** @type {const} */ ('providerMissing') };
      }
      if (provider.capabilities?.requiresRevalidation) {
        try {
          const result = await provider.revalidate(ref.token);
          if (result.valid) {
            return { pluginId: ref.pluginId, displayPath, status: /** @type {const} */ ('available') };
          }
          return {
            pluginId: ref.pluginId, displayPath,
            status: /** @type {const} */ ('invalid'),
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          };
        } catch {
          return { pluginId: ref.pluginId, displayPath, status: /** @type {const} */ ('unchecked') };
        }
      }
      return { pluginId: ref.pluginId, displayPath, status: /** @type {const} */ ('unchecked') };
    }));

    return { queueItemId, sources };
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
        this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.#activeEngine = undefined;

    this.#queue.clear();
    for (const item of snapshot.queue ?? []) {
      this.#queue.add(item.track);
    }
    const currentQueueItem = snapshot.currentQueueItem;
    const originalIndex = currentQueueItem
      ? snapshot.queue.findIndex((i) => i.queueItemId === currentQueueItem.queueItemId)
      : -1;
    this.#queue.setCurrentIndex(originalIndex);
    this.#queue.setShuffle(snapshot.shuffle ?? false);
    this.#queue.setRepeatMode(snapshot.repeatMode ?? 'off');
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
   * Core's own operation-chain serializer. Distinct from the public
   * enqueue() queue command above despite the similar name — this is the
   * general "run this operation after everything already queued" helper
   * every public command (play/pause/seek/enqueue/removeFromQueue/etc.)
   * goes through, not itself a queue mutation.
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
    // The queue's current pointer can move (selectQueueItem(), clicking a
    // different queue item in a host UI) without going through
    // next()/prev(), which always reload. play() must detect that case —
    // otherwise it treats "playing"/"paused" as "nothing to do" purely
    // from #status, silently resuming/no-op'ing on the stale engine
    // instead of switching to the queue's actual current item.
    const currentItem = this.#queue.getCurrentItem();
    const currentItemChanged = currentItem?.queueItemId !== this.#loadedQueueItemId;

    if (this.#status === 'playing' && !currentItemChanged) return;
    if (this.#status === 'paused' && this.#activeEngine && !currentItemChanged) {
      try {
        await this.#activeEngine.play();
      } catch (err) {
        this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
      this.#status = 'playing';
      this.emit('stateChanged');
      return;
    }
    if (this.#queue.getCurrentIndex() === -1) {
      if (this.#queue.getItems().length === 0) return;
      this.#queue.setCurrentIndex(0);
    }
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async #pause() {
    if (this.#status !== 'playing' || !this.#activeEngine) return;
    try {
      await this.#activeEngine.pause();
    } catch (err) {
      this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
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
        this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
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
    const moved = this.#queue.moveNext();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async #prev() {
    const moved = this.#queue.movePrevious();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @param {number} seconds @returns {Promise<void>} */
  async #seek(seconds) {
    if (!this.#activeEngine || this.#status === 'idle' || this.#status === 'error') return;
    try {
      await this.#activeEngine.seek(seconds);
    } catch (err) {
      this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
    }
  }

  /** @returns {Promise<void>} */
  async #loadAndPlayCurrent() {
    const queueItem = this.#queue.getCurrentItem();
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
      if (engine.capabilities.lookaheadPlayback && engine.setPlaybackPlan) {
        const entries = await this.#resolveLookaheadPlan(queueItem, resolved);
        this.#planRevision += 1;
        await engine.setPlaybackPlan({ revision: this.#planRevision, entries });
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
   * Builds the PlaybackPlanEntry[] window handed to a lookaheadPlayback
   * engine's setPlaybackPlan() (wrapped by the caller into a full
   * PlaybackPlan with the current #planRevision), starting at the current
   * queue item and resolving up to DEFAULT_LOOKAHEAD_WINDOW items ahead.
   *
   * @param {import('./types.js').QueueItem} currentQueueItem
   * @param {import('./types.js').ResolvedSource} currentResolved
   * @returns {Promise<import('./types.js').PlaybackPlanEntry[]>}
   */
  async #resolveLookaheadPlan(currentQueueItem, currentResolved) {
    /** @type {import('./types.js').PlaybackPlanEntry[]} */
    const plan = [{ queueItemId: currentQueueItem.queueItemId, resolved: currentResolved }];

    // repeat: 'one' means the current item plays again, not whatever's
    // next in the queue. A lookaheadPlayback engine has no visibility into
    // repeat mode on its own — setPlaybackPlan's entries are the only
    // thing it's told — so without this it would auto-advance into the
    // actual next queue item on its own instead of replaying the current
    // one. Padding the window with repeated copies of the current entry
    // makes the engine's own internal auto-advance do the right thing
    // without it ever needing to know repeat mode exists.
    if (this.#queue.getRepeatMode() === 'one') {
      while (plan.length < DEFAULT_LOOKAHEAD_WINDOW) {
        plan.push({ queueItemId: currentQueueItem.queueItemId, resolved: currentResolved });
      }
      return plan;
    }

    const items = this.#queue.getItems();
    const currentIdx = items.findIndex((i) => i.queueItemId === currentQueueItem.queueItemId);
    if (currentIdx === -1) return plan;
    const providers = this.#registry.getSourceProviders();
    // Known limitations: this walks queue.getItems() in plain array order,
    // not through QueueManager's shuffle history — there is no
    // non-mutating "peek the next N items" method yet — and it does not
    // wrap around for repeat: 'all'. At the last item under repeat: 'all',
    // the plan simply runs out; the engine reports 'playbackExhausted'
    // (see #bindEngine), and #advanceOnEnded's existing queue.moveNext()
    // call wraps correctly on its own, just via a full reload rather than
    // a gapless hand-off. Acceptable for now — revisit both alongside
    // each other if a future engine needs a genuinely gapless
    // shuffle/wrap transition too.
    for (let i = currentIdx + 1; i < items.length && plan.length < DEFAULT_LOOKAHEAD_WINDOW; i += 1) {
      const item = items[i];
      try {
        const resolved = await resolveTrack(item.track, this.#policy, providers);
        plan.push({ queueItemId: item.queueItemId, resolved });
      } catch {
        // A lookahead item that fails to resolve is just omitted from the
        // plan rather than aborting the whole window — this is the
        // non-fatal future-entry-failure path: the current track keeps
        // playing, and normal advancement (or a future 'playbackExhausted'
        // report) will surface a real error only if playback ever
        // actually reaches this item.
      }
    }
    return plan;
  }

  /**
   * Re-resolves and re-pushes the lookahead plan to the active
   * lookaheadPlayback engine after the queue changes shape (add, remove,
   * reorder) while that engine still owns the currently-loaded item. A
   * no-op for a non-lookaheadPlayback engine, or when nothing is
   * currently loaded. Every call installs a new, strictly-higher
   * #planRevision — the engine must treat it as superseding whatever
   * revision it was last given.
   * @returns {Promise<void>}
   */
  async #refreshLookaheadPlan() {
    if (!this.#activeEngine || !this.#activeEngine.capabilities.lookaheadPlayback) return;
    if (!this.#activeEngine.setPlaybackPlan) return;
    const currentQueueItem = this.#queue.getCurrentItem();
    if (!currentQueueItem || currentQueueItem.queueItemId !== this.#loadedQueueItemId) return;
    /** @type {import('./types.js').ResolvedSource} */
    let resolved;
    try {
      resolved = await resolveTrack(currentQueueItem.track, this.#policy, this.#registry.getSourceProviders());
    } catch {
      return;
    }
    const entries = await this.#resolveLookaheadPlan(currentQueueItem, resolved);
    this.#planRevision += 1;
    try {
      await this.#activeEngine.setPlaybackPlan({ revision: this.#planRevision, entries });
    } catch (err) {
      this.#emitError(currentQueueItem, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Handles a lookaheadPlayback engine's 'playbackStarted' — fired for
   * every actual start, including the initial play and a gapless
   * hand-off it drove internally via its plan (without Core calling
   * load()/play() again). Accepted only for the current #planRevision and
   * a queueItemId that is genuinely in the queue; an event for an
   * obsolete revision is silently ignored, not treated as an error — a
   * later revision always supersedes it, so a stale report reflects state
   * the engine itself should already be discarding.
   * @param {{ queueItemId?: string, planRevision?: number }} [payload]
   * @returns {Promise<void>}
   */
  async #handlePlaybackStarted(payload) {
    if (payload?.planRevision !== this.#planRevision) return;
    const newQueueItemId = payload?.queueItemId;
    if (!newQueueItemId) return;
    const items = this.#queue.getItems();
    const newIndex = items.findIndex((i) => i.queueItemId === newQueueItemId);
    if (newIndex === -1) return;
    if (newIndex !== this.#queue.getCurrentIndex()) {
      this.#queue.setCurrentIndex(newIndex);
    }
    this.#loadedQueueItemId = newQueueItemId;
    this.#status = 'playing';
    this.emit('trackChanged', items[newIndex]);
    this.emit('stateChanged');
  }

  /**
   * Handles a lookaheadPlayback engine's 'playbackExhausted' — fired
   * after the last actually-started entry in the accepted plan ends
   * without a prepared successor. Accepted only for the current
   * #planRevision (same obsolete-revision-is-ignored rule as
   * #handlePlaybackStarted); when accepted, applies the same
   * repeat/shuffle/end-of-queue resolution #advanceOnEnded already
   * implements for a non-lookahead engine's plain 'ended' — an
   * engine-side pre-buffer exhausting is a "what's next" question with
   * exactly the same answer as a single-track engine reaching the end of
   * its one loaded item, so this reuses that method directly rather than
   * building a second, separate implementation of it.
   * @param {{ queueItemId?: string, planRevision?: number }} [payload]
   * @returns {Promise<void>}
   */
  async #handlePlaybackExhausted(payload) {
    if (payload?.planRevision !== this.#planRevision) return;
    await this.#advanceOnEnded();
  }

  /** @returns {Promise<void>} */
  async #advanceOnEnded() {
    if (this.#queue.getRepeatMode() === 'one' && this.#queue.getCurrentItem()) {
      await this.#loadAndPlayCurrent();
      return;
    }
    const moved = this.#queue.moveNext();
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
    if (this.#queue.getItems().some((i) => i.queueItemId === missingQueueItemId)) return;
    await this.#stop();
  }

  /** @param {import('./types.js').PlaybackEngine} engine @returns {void} */
  #bindEngine(engine) {
    this.#activeEngine = engine;
    engine.setVolume(this.#volume);
    if (this.#boundEngines.has(engine)) return;
    this.#boundEngines.add(engine);

    /** @type {Array<[string, (payload?: any) => void]>} */
    const listeners = [];
    this.#engineListeners.set(engine, listeners);
    /**
     * @param {string} event
     * @param {(payload?: any) => void} handler
     * @returns {void}
     */
    const bind = (event, handler) => {
      engine.on(/** @type {any} */ (event), handler);
      listeners.push([event, handler]);
    };

    const POSITION_THROTTLE_MS = 250;
    let lastEmit = 0;
    bind('progress', (payload) => {
      const { position = 0, duration = 0 } = payload ?? {};
      this.#position = position;
      this.#duration = duration;
      const now = Date.now();
      if (now - lastEmit >= POSITION_THROTTLE_MS) {
        lastEmit = now;
        this.emit('positionChanged', { position, duration });
      }
    });

    // 'ended' is bound unconditionally for both engine kinds: a
    // non-lookahead engine reports it after every single track (unchanged
    // from before). A lookaheadPlayback engine drives its own queue
    // advancement internally (via the plan handed to setPlaybackPlan) and
    // reports each successful internal hand-off through 'playbackStarted'
    // instead — Core reconciles its own queue pointer to match rather than
    // treating that as playback finishing — but it still reports 'ended'
    // if it has no lookahead plan machinery in play at all for the current
    // load. In practice a lookaheadPlayback engine reports exhaustion via
    // 'playbackExhausted' (bound below), not 'ended' — 'ended' stays bound
    // here for engines that never opt into lookahead at all.
    bind('ended', () => {
      this.#enqueue(() => this.#advanceOnEnded()).catch((err) => {
        this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
      });
    });
    if (engine.capabilities.lookaheadPlayback) {
      bind('playbackStarted', (payload) => {
        this.#enqueue(() => this.#handlePlaybackStarted(payload)).catch((err) => {
          this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        });
      });
      bind('playbackExhausted', (payload) => {
        this.#enqueue(() => this.#handlePlaybackExhausted(payload)).catch((err) => {
          this.#emitError(this.#queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        });
      });
    }

    bind('error', (error) => {
      this.#emitError(this.#queue.getCurrentItem(), error instanceof Error ? error.message : String(error));
    });

    // 'transportCommand' (a lock-screen/CarPlay/Android-Auto button press,
    // on a nowPlaying-capable engine) is deliberately NOT bound here —
    // translating it into play()/pause()/next()/prev() is host policy, the
    // same way capabilities never drive routing decisions on their own
    // beyond requiresRevalidation and lookaheadPlayback. A host that wants
    // this wires engine.on('transportCommand', ...) itself, directly
    // against the engine instance it already holds a reference to.
  }

  /**
   * @param {import('./types.js').QueueItem | undefined} queueItem
   * @param {string} reason
   * @param {Array<{ pluginId: string, token: import('./types.js').SourceToken, reason: string }>} [failedSources]
   * @returns {void}
   */
  #emitError(queueItem, reason, failedSources = []) {
    this.#loadedQueueItemId = undefined;
    this.#status = 'error';
    this.emit('error', {
      queueItemId: queueItem?.queueItemId,
      trackId: queueItem?.track.id,
      reason,
      // failedSources arrives here (from Resolver.js's TrackResolutionError,
      // when this call is reached via a resolution failure) with each
      // entry still carrying its full SourceToken, including the opaque
      // `.token` value — TrackResolutionError is an internal control-flow
      // exception this method is the only consumer of, so keeping the full
      // token there is harmless. This public 'error' event is a different
      // boundary, though: it's the one place that value could leak to a
      // host's logs/UI. Redact down to pluginId + the token's own
      // displayPath (documented on SourceToken as safe to show/log) before
      // it leaves Core — never the raw token.
      failedSources: failedSources.map((failure) => ({
        pluginId: failure.pluginId,
        displayPath: failure.token?.displayPath,
        reason: failure.reason,
      })),
    });
    this.emit('stateChanged');
  }
}
