/**
 * A minimal, from-scratch stand-in for HTMLAudioElement, built on Node's
 * real (global) EventTarget — the same "write a dependency-free stand-in"
 * approach @unitrack/engine-web-audio's tests use, for the same reason:
 * the real platform primitive (a browser's <audio> element) isn't
 * available in this test runtime at all.
 * @returns {any}
 */
function createFakeAudioElement() {
  const target = new EventTarget();
  return Object.assign(target, {
    src: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    volume: 1,
    loadCalls: 0,
    playCalls: 0,
    /** @type {{ code: number } | null} */
    error: null,
    _canPlayTypeResult: 'probably',

    load() {
      this.loadCalls += 1;
    },

    async play() {
      this.playCalls += 1;
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

/**
 * Returns a constructor function that creates a *fresh* fake audio element
 * on every `new AudioConstructor()` call, and records every instance it
 * creates (in creation order) on `.instances` — unlike
 * @unitrack/engine-web-audio's tests, which only ever construct one
 * `Audio`, this engine owns two independent <audio> elements (one per
 * slot) at once, so tests need a way to construct several distinct fakes
 * and still get a handle back to each one afterwards.
 * @returns {any}
 */
export function createFakeAudioConstructor() {
  /** @type {any[]} */
  const instances = [];
  function FakeAudioConstructor() {
    const instance = createFakeAudioElement();
    instances.push(instance);
    return instance;
  }
  FakeAudioConstructor.instances = instances;
  return FakeAudioConstructor;
}

/**
 * Resolves once every already-queued microtask has run — the same
 * `setImmediate` flush @unitrack/core's own CorePlayer.test.js uses to let
 * an engine's internally-chained promises (e.g. setPlaybackPlan()'s
 * sequential slot loads) settle between a test's synchronous event
 * simulations.
 * @returns {Promise<void>}
 */
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
