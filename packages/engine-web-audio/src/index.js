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

/** @type {Record<string, string>} */
const FORMAT_MIME_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

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
  sourceNode.connect(audioContext.destination);

  let buffering = false;
  audio.addEventListener('waiting', () => { buffering = true; });
  audio.addEventListener('playing', () => { buffering = false; });

  return {
    id: 'web-audio',

    /**
     * @param {import('@unitrack/core/types').ResolvedSource} resolved
     * @returns {boolean}
     */
    canPlay(resolved) {
      if (!resolved.format) return true;
      const mime = FORMAT_MIME_TYPES[resolved.format];
      if (!mime) return true;
      return audio.canPlayType(mime) !== '';
    },

    /**
     * @param {import('@unitrack/core/types').ResolvedSource} resolved
     * @returns {Promise<void>}
     */
    async load(resolved) {
      audio.src = resolved.url;
      audio.load();
      await /** @type {Promise<void>} */ (
        new Promise((resolve, reject) => {
          audio.addEventListener('canplay', () => resolve(), { once: true });
          audio.addEventListener('error', () => reject(mapMediaError(audio.error)), { once: true });
        })
      );
    },

    /** @returns {Promise<void>} */
    async play() {
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
     * @param {'ended'|'error'|'progress'} event
     * @param {(payload?: any) => void} handler
     * @returns {void}
     */
    on(event, handler) {
      if (event === 'progress') {
        audio.addEventListener('timeupdate', () => {
          handler({ position: audio.currentTime, duration: audio.duration || 0 });
        });
      } else if (event === 'ended') {
        audio.addEventListener('ended', () => handler());
      } else if (event === 'error') {
        audio.addEventListener('error', () => handler(mapMediaError(audio.error)));
      }
    },

    /** @returns {MediaElementAudioSourceNode} */
    getAudioGraphAnchor() {
      return sourceNode;
    },
  };
}
