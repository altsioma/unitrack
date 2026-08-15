/**
 * A minimal, from-scratch stand-in for HTMLAudioElement, built on Node's
 * real (global) EventTarget — the same "write a dependency-free stand-in"
 * approach @unitrack/core uses for its own EventEmitter instead of
 * node:events, for the same underlying reason: the real platform
 * primitive (a browser's <audio> element) isn't available in this test
 * runtime at all.
 * @returns {any}
 */
export function createFakeAudioElement() {
  const target = new EventTarget();
  return Object.assign(target, {
    src: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    /** @type {{ code: number } | null} */
    error: null,
    _canPlayTypeResult: 'probably',

    load() {},

    async play() {
      this.paused = false;
      this.dispatchEvent(new Event('playing'));
    },

    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    },

    /** @returns {string} */
    canPlayType() {
      return this._canPlayTypeResult;
    },

    /** @param {number} [duration] */
    _simulateCanPlay(duration = 0) {
      this.duration = duration;
      this.dispatchEvent(new Event('canplay'));
    },

    /** @param {number} code */
    _simulateError(code) {
      this.error = { code };
      this.dispatchEvent(new Event('error'));
    },

    /** @param {number} position */
    _simulateTimeUpdate(position) {
      this.currentTime = position;
      this.dispatchEvent(new Event('timeupdate'));
    },

    _simulateEnded() {
      this.dispatchEvent(new Event('ended'));
    },

    _simulateWaiting() {
      this.dispatchEvent(new Event('waiting'));
    },
  });
}

/** @returns {any} */
export function createFakeAudioContext() {
  return {
    /** @type {'running' | 'suspended' | 'closed'} */
    state: 'running',
    destination: {},
    async resume() {
      this.state = 'running';
    },
    /** @param {any} audioElement */
    createMediaElementSource(audioElement) {
      return {
        audioElement,
        connectedTo: undefined,
        /** @param {any} destination */
        connect(destination) {
          this.connectedTo = destination;
        },
        disconnect() {
          this.connectedTo = undefined;
        },
      };
    },
  };
}

/**
 * Wraps an already-created stub instance in a constructor function, so
 * `new AudioConstructor()` inside the engine returns this exact instance
 * (JS's `new` returns whatever object a constructor function explicitly
 * returns, instead of a fresh `this`) — letting a test hold a reference to
 * simulate events on the very instance the engine is using.
 * @param {any} instance
 * @returns {any}
 */
export function asConstructor(instance) {
  return function FakeConstructor() {
    return instance;
  };
}
