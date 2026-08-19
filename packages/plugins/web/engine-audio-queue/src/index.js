/** @type {Record<number, string>} */
const MEDIA_ERROR_MESSAGES = {
  1: 'MEDIA_ERR_ABORTED: fetching process aborted by the user',
  2: 'MEDIA_ERR_NETWORK: a network error occurred while fetching the media',
  3: 'MEDIA_ERR_DECODE: an error occurred while decoding the media',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED: the media format is not supported',
};

/**
 * @param {{ code: number } | null | undefined} error
 * @returns {Error}
 */
function mapMediaError(error) {
  if (!error) return new Error('Unknown media error');
  return new Error(MEDIA_ERROR_MESSAGES[error.code] ?? `MediaError code ${error.code}`);
}

import { CONTRACT_VERSION } from '@unitrack/core/types';
import { acquireWebMediaUrl } from '@unitrack/media-delivery-web';

/**
 * Waits for a freshly-load()ed element to become playable — the same
 * canplay/error race @unitrack/engine-web-audio's load() uses.
 * @param {any} el
 * @returns {Promise<void>}
 */
function waitUntilPlayable(el) {
  const controller = new AbortController();
  return /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      el.addEventListener('canplay', () => resolve(), { signal: controller.signal });
      el.addEventListener('error', () => reject(mapMediaError(el.error)), { signal: controller.signal });
    })
  ).finally(() => controller.abort());
}

/**
 * @typedef {{
 *   id: 'A' | 'B',
 *   el: any,
 *   loadedQueueItemId: string | undefined,
 *   ready: boolean,
 *   loading: boolean,
 *   loadController: AbortController | undefined,
 *   releaseLease: (() => void) | undefined,
 * }} Slot
 */

/**
 * A chained-HTMLAudioElement lookaheadPlayback playback engine: it
 * owns two <audio> elements ("slots") instead of one. Whichever slot is
 * currently audible is the "active" slot; the other is kept pre-loaded
 * with whatever setPlaybackPlan() says comes next, so that when the
 * active slot's 'ended' fires, starting the next track is a plain
 * .play() call on an element that is already buffered and ready —
 * instead of Core reacting to 'ended', calling load() on a fresh URL, and
 * waiting for 'canplay' before it can call play() again. That per-track
 * load()-then-play() round trip through Core's own JS is exactly the gap
 * a suspended/throttled JS thread (a backgrounded WKWebView, a background
 * browser tab) can turn into a dropped or badly-delayed track transition
 * — see the design spec's Problem Statement.
 *
 * What this does NOT solve: the active slot's own 'ended' event, and this
 * engine's own listener for it, still have to run on this page's JS
 * thread to trigger the hand-off at all. If the JS thread is fully
 * suspended (not just throttled) at the moment a track ends, no amount of
 * pre-buffering here helps — that is why capabilities.backgroundPlayback
 * stays false. What this engine buys is a much smaller JS-thread
 * dependency per transition (one already-armed .play() call, versus a
 * full load()/canplay/play() cycle against a URL nothing has touched
 * yet), which meaningfully narrows, but does not close, that window.
 * Fully closing it needs a native/OS-level queue (a real
 * AVQueuePlayer-style host integration) — out of scope here; see the
 * design spec's Out of Scope.
 *
 * @param {{ AudioConstructor?: typeof Audio }} [options]
 * @returns {import('@unitrack/core/types').PlaybackEngine}
 */
export function createAudioQueuePlaybackEngine({ AudioConstructor = globalThis.Audio } = {}) {
  /** @type {Map<string, Set<(payload?: any) => void>>} */
  const listeners = new Map();

  /**
   * @param {string} event
   * @param {any} [payload]
   * @returns {void}
   */
  function fire(event, payload) {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  }

  /**
   * @param {'A' | 'B'} id
   * @returns {Slot}
   */
  function makeSlot(id) {
    const el = new AudioConstructor();
    /** @type {Slot} */
    const slot = {
      id, el, loadedQueueItemId: undefined, ready: false, loading: false,
      loadController: undefined, releaseLease: undefined,
    };
    el.addEventListener('timeupdate', () => {
      if (slot !== activeSlot) return;
      fire('progress', { position: el.currentTime, duration: el.duration || 0 });
    });
    el.addEventListener('waiting', () => {
      if (slot === activeSlot) buffering = true;
    });
    el.addEventListener('playing', () => {
      if (slot === activeSlot) buffering = false;
    });
    el.addEventListener('error', () => {
      if (slot !== activeSlot) return;
      // A load() in flight (see waitUntilPlayable, called from
      // loadIntoSlot) has its own reject path for this same event —
      // forwarding it again here as a steady-state 'error' would
      // double-report the same failure.
      if (slot.loading) return;
      fire('error', mapMediaError(el.error));
    });
    el.addEventListener('ended', () => {
      if (slot !== activeSlot) return;
      handleActiveSlotEnded();
    });
    return slot;
  }

  const slotA = makeSlot('A');
  const slotB = makeSlot('B');
  /** @type {Slot} */
  let activeSlot = slotA;
  /** @type {Slot} */
  let inactiveSlot = slotB;
  let buffering = false;
  /** @type {import('@unitrack/core/types').PlaybackPlanEntry[]} */
  let plan = [];
  // The revision of the most recently accepted PlaybackPlan. A fresh
  // Core-issued revision is always > 0 (Core increments its own counter
  // before ever calling setPlaybackPlan), so 0 here means "no plan
  // accepted yet" and naturally fails the staleness check on the first
  // real call.
  let currentRevision = 0;

  /**
   * @param {Slot} slot
   * @param {import('@unitrack/core/types').PlaybackPlanEntry} entry
   * @returns {Promise<void>}
   */
  async function loadIntoSlot(slot, entry) {
    if (entry.resolved.kind !== 'url' || !entry.resolved.url) {
      throw new Error(`audio-queue engine only supports kind: 'url' sources, got "${entry.resolved.kind}"`);
    }
    // Supersede whatever this slot was previously loading/holding: abort
    // its own acquireWebMediaUrl() fetch (a no-op if the entry had no
    // headers, since then there was never a fetch) and release its lease,
    // if it had already resolved one.
    slot.loadController?.abort();
    slot.releaseLease?.();
    slot.releaseLease = undefined;

    slot.ready = false;
    slot.loadedQueueItemId = entry.queueItemId;
    slot.loading = true;
    const loadController = new AbortController();
    slot.loadController = loadController;
    try {
      const lease = await acquireWebMediaUrl(entry.resolved, { signal: loadController.signal });
      slot.releaseLease = lease.release;
      slot.el.src = lease.url;
      slot.el.load();
      await waitUntilPlayable(slot.el);
      slot.ready = true;
    } finally {
      slot.loading = false;
    }
  }

  /**
   * Loads plan[1] (if present and not already loaded) into whichever slot
   * is not currently active, so it is ready by the time the active slot
   * ends. A failure here is swallowed rather than thrown — the current
   * track is still playing fine; losing the pre-buffer just means the
   * next transition falls back to a plain 'ended' report instead of a
   * gapless hand-off, same as if no lookahead entry had been available at
   * all.
   * @returns {Promise<void>}
   */
  async function prepareNextSlot() {
    const next = plan[1];
    if (!next) {
      inactiveSlot.loadController?.abort();
      inactiveSlot.releaseLease?.();
      inactiveSlot.releaseLease = undefined;
      inactiveSlot.loadedQueueItemId = undefined;
      inactiveSlot.ready = false;
      return;
    }
    if (inactiveSlot.loadedQueueItemId === next.queueItemId && inactiveSlot.ready) return;
    try {
      await loadIntoSlot(inactiveSlot, next);
    } catch {
      // Left unready — see doc comment above.
    }
  }

  /** @returns {void} */
  function handleActiveSlotEnded() {
    const finishedQueueItemId = activeSlot.loadedQueueItemId;
    const next = plan[1];
    if (!next || inactiveSlot.loadedQueueItemId !== next.queueItemId || !inactiveSlot.ready) {
      // Nothing pre-buffered and ready to hand off to — this is a
      // genuine end of what this engine currently knows about. Core's
      // #advanceOnEnded (triggered by 'playbackExhausted') decides what
      // happens next (including whether the plan simply needs refreshing
      // because the real queue has more).
      fire('playbackExhausted', { queueItemId: finishedQueueItemId, planRevision: currentRevision });
      return;
    }
    const finishedSlot = activeSlot;
    activeSlot = inactiveSlot;
    inactiveSlot = finishedSlot;
    plan = plan.slice(1);
    const newQueueItemId = next.queueItemId;
    activeSlot.el.play().catch((/** @type {unknown} */ err) => {
      fire('error', err instanceof Error ? err : new Error(String(err)));
    });
    fire('playbackStarted', { queueItemId: newQueueItemId, planRevision: currentRevision });
    // Reset the now-inactive (previously active) slot — including
    // releasing the lease backing whatever it just finished playing — and
    // try to pre-buffer whatever the plan now says is next, into it.
    inactiveSlot.loadController?.abort();
    inactiveSlot.releaseLease?.();
    inactiveSlot.releaseLease = undefined;
    inactiveSlot.loadedQueueItemId = undefined;
    inactiveSlot.ready = false;
    inactiveSlot.el.pause();
    prepareNextSlot().catch(() => {});
  }

  return {
    id: 'audio-queue',
    contractVersion: CONTRACT_VERSION,

    // This is a lookaheadPlayback engine — it pre-buffers and advances
    // between the tracks in its own plan. See the module doc comment
    // above for the gapless/backgroundPlayback rationale.
    capabilities: { gapless: true, backgroundPlayback: false, lookaheadPlayback: true },

    /**
     * @param {import('@unitrack/core/types').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async initialize(ctx) {},

    /** @returns {Promise<void>} */
    async dispose() {
      for (const slot of [slotA, slotB]) {
        slot.loadController?.abort();
        slot.releaseLease?.();
        slot.releaseLease = undefined;
        slot.el.pause();
      }
      plan = [];
    },

    /**
     * @param {import('@unitrack/core/types').ResolvedSource} resolved
     * @returns {Promise<boolean>}
     */
    async canPlay(resolved) {
      if (resolved.kind !== 'url') return false;
      if (!resolved.mime) return true;
      return activeSlot.el.canPlayType(resolved.mime) !== '';
    },

    /**
     * Loads a single ResolvedSource directly into the active slot,
     * bypassing plan tracking. Present for PlaybackEngine contract
     * completeness — Core never calls this on a lookaheadPlayback engine
     * (it calls setPlaybackPlan() instead; see
     * CorePlayer#loadAndPlayCurrent), so this only matters for a host or
     * test driving the engine standalone.
     * @param {import('@unitrack/core/types').ResolvedSource} resolved
     * @returns {Promise<void>}
     */
    async load(resolved) {
      plan = [];
      await loadIntoSlot(activeSlot, { queueItemId: /** @type {any} */ (undefined), resolved });
    },

    /**
     * Loads the current entry into the active slot (if it is not already
     * there and ready) and pre-buffers the next entry, if any, into the
     * inactive slot. Does not itself start playback — Core always follows
     * this with play(), same as the load()+play() pair a non-lookahead
     * engine gets. A revision that is not strictly greater than the one
     * most recently accepted is treated as stale and ignored outright —
     * defensive groundwork against a future multi-writer scenario; under
     * Core's own single-writer, strictly-increasing counter this should
     * never actually trigger.
     * @param {import('@unitrack/core/types').PlaybackPlan} newPlan
     * @returns {Promise<void>}
     */
    async setPlaybackPlan(newPlan) {
      if (newPlan.revision <= currentRevision) return;
      currentRevision = newPlan.revision;
      plan = newPlan.entries;
      const first = plan[0];
      if (!first) return;
      if (activeSlot.loadedQueueItemId !== first.queueItemId || !activeSlot.ready) {
        await loadIntoSlot(activeSlot, first);
      }
      await prepareNextSlot();
    },

    /** @returns {Promise<void>} */
    async play() {
      await activeSlot.el.play();
    },

    /** @returns {Promise<void>} */
    async pause() {
      activeSlot.el.pause();
    },

    /** @returns {Promise<void>} */
    async stop() {
      // Core always calls setPlaybackPlan() again before the next play()
      // after a stop() (see CorePlayer#stop clearing #loadedQueueItemId),
      // so it's safe to release both slots' leases here — nothing will
      // try to keep playing a now-revoked object URL. ready/loadedQueueItemId
      // are reset alongside the release so a future setPlaybackPlan() call
      // that happens to name the same entry doesn't skip reloading it
      // (setPlaybackPlan's activeSlot.ready check would otherwise still see
      // "ready" against an <audio> element now pointed at a revoked blob:
      // URL).
      for (const slot of [activeSlot, inactiveSlot]) {
        slot.loadController?.abort();
        slot.releaseLease?.();
        slot.releaseLease = undefined;
        slot.loadedQueueItemId = undefined;
        slot.ready = false;
      }
      activeSlot.el.pause();
      activeSlot.el.currentTime = 0;
    },

    /**
     * @param {number} seconds
     * @returns {Promise<void>}
     */
    async seek(seconds) {
      activeSlot.el.currentTime = seconds;
    },

    /** @returns {import('@unitrack/core/types').EngineState} */
    getState() {
      return {
        position: activeSlot.el.currentTime,
        duration: activeSlot.el.duration || 0,
        buffering,
      };
    },

    /**
     * @param {'ended'|'error'|'progress'|'playbackStarted'|'playbackExhausted'|'transportCommand'} event
     * @param {(payload?: any) => void} handler
     * @returns {void}
     */
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      /** @type {Set<(payload?: any) => void>} */ (listeners.get(event)).add(handler);
    },

    /**
     * @param {'ended'|'error'|'progress'|'playbackStarted'|'playbackExhausted'|'transportCommand'} event
     * @param {(payload?: any) => void} handler
     * @returns {void}
     */
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },

    /**
     * @param {number} volume
     * @returns {void}
     */
    setVolume(volume) {
      if (!Number.isFinite(volume)) return;
      const clamped = Math.max(0, Math.min(1, volume));
      slotA.el.volume = clamped;
      slotB.el.volume = clamped;
    },

    /** @returns {number} */
    getVolume() {
      return activeSlot.el.volume;
    },
  };
}
