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

  /** @type {Map<string, Map<(payload?: any) => void, EventListener>>} */
  const listenersByEvent = new Map();

  return {
    id: 'web-audio',
    contractVersion: CONTRACT_VERSION,

    // This engine drives one HTMLAudioElement at a time and relies on Core
    // to feed it tracks one-by-one via load()+play() — it does not own the
    // queue itself, so queueAuthority stays 'core'. gapless is not
    // implemented (load() tears down and reloads the single <audio> src on
    // every track). backgroundPlayback is false because a suspended
    // WKWebView/background tab can stop this engine's JS timers same as any
    // other in-page audio element.
    capabilities: { gapless: false, backgroundPlayback: false, queueAuthority: 'core' },

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
      audio.src = resolved.url;
      audio.load();
      loading = true;
      const controller = new AbortController();
      try {
        await /** @type {Promise<void>} */ (
          new Promise((resolve, reject) => {
            audio.addEventListener('canplay', () => resolve(), { signal: controller.signal });
            audio.addEventListener('error', () => reject(mapMediaError(audio.error)), { signal: controller.signal });
          })
        );
      } finally {
        loading = false;
        controller.abort();
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
     * @param {'ended'|'error'|'progress'|'trackChanged'|'transportCommand'} event
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
      // 'trackChanged' is only emitted by queueAuthority: 'engine' engines
      // that own the queue via setPlaybackPlan(). This engine's
      // capabilities.queueAuthority is 'core', so it never fires one.
      // 'transportCommand' is only emitted by nowPlaying-capable engines;
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
     * @param {'ended'|'error'|'progress'|'trackChanged'|'transportCommand'} event
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
