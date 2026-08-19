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
 * @param {{ AudioConstructor?: typeof Audio, AudioContextConstructor?: typeof AudioContext }} [options]
 * @returns {import('@unitrack/core/types').PlaybackEngine}
 */
export function createWebAudioPlaybackEngine({
  AudioConstructor = globalThis.Audio,
  AudioContextConstructor = globalThis.AudioContext,
} = {}) {
  const audio = new AudioConstructor();
  const audioContext = new AudioContextConstructor();
  const sourceNode = audioContext.createMediaElementSource(audio);
  const gainNode = audioContext.createGain();
  sourceNode.connect(gainNode);
  gainNode.connect(audioContext.destination);

  let buffering = false;
  audio.addEventListener('waiting', () => { buffering = true; });
  audio.addEventListener('playing', () => { buffering = false; });

  // True while a load() call is in flight. Suppresses the persistent
  // on('error') forwarder below so a media error during a load doesn't
  // produce two error reports for the same failure — one from this
  // forwarder and one from load()'s own rejection.
  let loading = false;

  // The AbortController for whichever acquireWebMediaUrl() fetch (if any —
  // header-less sources never actually fetch) is currently in flight, and
  // the release() for whichever lease is currently backing audio.src. Both
  // are torn down by a new load(), by stop(), and by dispose() — see the
  // module doc comment on @unitrack/media-delivery-web for why a lease
  // needs releasing at all.
  /** @type {AbortController | undefined} */
  let currentLoadController;
  /** @type {(() => void) | undefined} */
  let releaseCurrentLease;

  /** @type {Map<string, Map<(payload?: any) => void, EventListener>>} */
  const listenersByEvent = new Map();

  return {
    id: 'web-audio',
    contractVersion: CONTRACT_VERSION,

    // This engine drives one HTMLAudioElement at a time and relies on Core
    // to feed it tracks one-by-one via load()+play() — it does not
    // pre-buffer a lookahead plan, so lookaheadPlayback stays false. gapless
    // is not implemented (load() tears down and reloads the single <audio>
    // src on every track). backgroundPlayback is false because a suspended
    // WKWebView/background tab can stop this engine's JS timers same as any
    // other in-page audio element.
    capabilities: { gapless: false, backgroundPlayback: false, lookaheadPlayback: false },

    /**
     * @param {import('@unitrack/core/types').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async initialize(ctx) {},

    /**
     * Closes the underlying AudioContext, guarded so a repeated or
     * post-close dispose() call is a no-op rather than throwing.
     * @returns {Promise<void>}
     */
    async dispose() {
      currentLoadController?.abort();
      releaseCurrentLease?.();
      releaseCurrentLease = undefined;
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    },

    /**
     * @param {import('@unitrack/core/types').ResolvedSource} resolved
     * @returns {Promise<boolean>}
     */
    async canPlay(resolved) {
      if (resolved.kind !== 'url') return false;
      if (!resolved.mime) return true;
      return audio.canPlayType(resolved.mime) !== '';
    },

    /**
     * @param {import('@unitrack/core/types').ResolvedSource} resolved
     * @returns {Promise<void>}
     */
    async load(resolved) {
      if (resolved.kind !== 'url' || !resolved.url) {
        throw new Error(`web-audio engine only supports kind: 'url' sources, got "${resolved.kind}"`);
      }
      // Supersede any load() still in flight: abort its own
      // acquireWebMediaUrl() fetch (a no-op if it had no headers to begin
      // with, since then there was never a fetch) and release its lease,
      // if it had already resolved one, before starting this one.
      currentLoadController?.abort();
      releaseCurrentLease?.();
      releaseCurrentLease = undefined;

      const loadController = new AbortController();
      currentLoadController = loadController;
      const lease = await acquireWebMediaUrl(resolved, { signal: loadController.signal });
      releaseCurrentLease = lease.release;

      audio.src = lease.url;
      audio.load();
      loading = true;
      const canplayController = new AbortController();
      try {
        await /** @type {Promise<void>} */ (
          new Promise((resolve, reject) => {
            audio.addEventListener('canplay', () => resolve(), { signal: canplayController.signal });
            audio.addEventListener('error', () => reject(mapMediaError(audio.error)), { signal: canplayController.signal });
          })
        );
      } finally {
        loading = false;
        canplayController.abort();
      }
    },

    /** @returns {Promise<void>} */
    async play() {
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      await audio.play();
    },

    /** @returns {Promise<void>} */
    async pause() {
      audio.pause();
    },

    /** @returns {Promise<void>} */
    async stop() {
      // Core always calls load() again before the next play() after a
      // stop() (see CorePlayer#stop clearing #loadedQueueItemId), so it's
      // safe to release the lease here — nothing will try to keep playing
      // the now-revoked object URL.
      currentLoadController?.abort();
      releaseCurrentLease?.();
      releaseCurrentLease = undefined;
      audio.pause();
      audio.currentTime = 0;
    },

    /**
     * @param {number} seconds
     * @returns {Promise<void>}
     */
    async seek(seconds) {
      audio.currentTime = seconds;
    },

    /** @returns {import('@unitrack/core/types').EngineState} */
    getState() {
      return {
        position: audio.currentTime,
        duration: audio.duration || 0,
        buffering,
      };
    },

    /**
     * @param {'ended'|'error'|'progress'|'playbackStarted'|'playbackExhausted'|'transportCommand'} event
     * @param {(payload?: any) => void} handler
     * @returns {void}
     */
    on(event, handler) {
      /** @type {EventListener | undefined} */
      let wrapped;
      if (event === 'progress') {
        wrapped = () => handler({ position: audio.currentTime, duration: audio.duration || 0 });
        audio.addEventListener('timeupdate', wrapped);
      } else if (event === 'ended') {
        wrapped = () => handler();
        audio.addEventListener('ended', wrapped);
      } else if (event === 'error') {
        wrapped = () => {
          if (!loading) handler(mapMediaError(audio.error));
        };
        audio.addEventListener('error', wrapped);
      }
      // 'playbackStarted'/'playbackExhausted' are only emitted by
      // lookaheadPlayback engines that pre-buffer via setPlaybackPlan().
      // This engine's capabilities.lookaheadPlayback is false, so it never
      // fires either. 'transportCommand' is only emitted by nowPlaying-capable engines;
      // this engine doesn't declare that capability. Both event names are
      // still accepted here (rather than throwing) purely so a host written
      // against the general PlaybackEngine contract can register for them
      // unconditionally without checking capabilities first — off() below
      // is then also a safe no-op for them, since nothing was ever attached.
      if (!wrapped) return;
      let handlers = listenersByEvent.get(event);
      if (!handlers) {
        handlers = new Map();
        listenersByEvent.set(event, handlers);
      }
      handlers.set(handler, wrapped);
    },

    /**
     * @param {'ended'|'error'|'progress'|'playbackStarted'|'playbackExhausted'|'transportCommand'} event
     * @param {(payload?: any) => void} handler
     * @returns {void}
     */
    off(event, handler) {
      const wrapped = listenersByEvent.get(event)?.get(handler);
      if (!wrapped) return;
      const domEvent = event === 'progress' ? 'timeupdate' : event;
      audio.removeEventListener(domEvent, wrapped);
      listenersByEvent.get(event)?.delete(handler);
    },

    /**
     * @param {number} volume
     * @returns {void}
     */
    setVolume(volume) {
      if (!Number.isFinite(volume)) {
        return;
      }
      gainNode.gain.value = Math.max(0, Math.min(1, volume));
    },

    /** @returns {number} */
    getVolume() {
      return gainNode.gain.value;
    },

    /** @returns {MediaElementAudioSourceNode} */
    getAudioGraphAnchor() {
      return sourceNode;
    },
  };
}
