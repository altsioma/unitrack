# @unitrack/engine-web-audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/engine-web-audio` — a `PlaybackEngine` plugin for `@unitrack/core` that plays a `ResolvedSource` via a `MediaElementAudioSourceNode`-backed `<audio>` element — as specified in `docs/superpowers/specs/2026-08-15-engine-web-audio-design.md`.

**Architecture:** A single new npm workspace package, `packages/engine-web-audio/`, exporting one factory function, `createWebAudioPlaybackEngine(options?)`, that wraps an injected `Audio`/`AudioContext` pair (defaulting to the real browser globals) and returns a plain object satisfying `@unitrack/core`'s `PlaybackEngine` contract. No runtime dependency on `@unitrack/core` — it's a devDependency used only for JSDoc type-checking.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs` (`"lib": ["ES2022", "DOM"]`, no `@types/node` — this package touches no Node built-ins). Tests via Node's built-in `node:test` + `node:assert/strict`, against a from-scratch DOM/Web Audio stub (no real browser, no mocking library). Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies. `@unitrack/core` and `typescript` are devDependencies only. No `@types/node`.
- `Audio`/`AudioContext` are injected into the factory via optional `AudioConstructor`/`AudioContextConstructor` parameters, defaulting to `globalThis.Audio`/`globalThis.AudioContext` — never referenced as bare globals inside the implementation, so the whole engine is constructible against a test stub.
- Uses `MediaElementAudioSourceNode` (via `audioContext.createMediaElementSource(audio)`), not `AudioBufferSourceNode`.
- `load(resolved)` sets `audio.src`/calls `audio.load()`, then resolves on the first `'canplay'` event or rejects (with a mapped `MediaError`) on the first `'error'` event — it does not return before the source is confirmed ready or confirmed broken.
- `canPlay(resolved)` is permissive by default: only returns `false` when `resolved.format` maps to a known MIME type AND `audio.canPlayType(mime)` reports it can't play it (`''`). Absent or unmapped formats return `true`.
- `on('progress', ...)` forwards the native `'timeupdate'` event unthrottled — `CorePlayer` already throttles on its side.
- Out of scope for this plan (per spec Non-goals): any EQ/DSP implementation, an `AudioBufferSourceNode` code path, automated real-browser testing, a universal audio graph API.
- `npm run typecheck` and `npm test`, run from the repo root, must both pass cleanly (delegating into every workspace package) at the end of the task.

---

## Task 1: Scaffold and implement @unitrack/engine-web-audio

**Files:**
- Create: `packages/engine-web-audio/package.json`
- Create: `packages/engine-web-audio/tsconfig.json`
- Create: `packages/engine-web-audio/src/index.js`
- Create: `packages/engine-web-audio/test/helpers/domStubs.js`
- Create: `packages/engine-web-audio/test/index.test.js`

**Interfaces:**
- Consumes: `@unitrack/core`'s JSDoc types (`ResolvedSource`, `EngineState`, `PlaybackEngine`) from `packages/core/src/types.js`, referenced via `import('@unitrack/core/types').X` — resolvable once `npm install` links the workspace. No runtime import from `@unitrack/core`.
- Produces: `export function createWebAudioPlaybackEngine(options?: { AudioConstructor?: typeof Audio, AudioContextConstructor?: typeof AudioContext }): PlaybackEngine` from `packages/engine-web-audio/src/index.js` — this is the package's entire public surface. Also produces (test-only, not exported from `src/`) `createFakeAudioElement()`, `createFakeAudioContext()`, and `asConstructor(instance)` from `test/helpers/domStubs.js`, used throughout `test/index.test.js`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@unitrack/engine-web-audio",
  "version": "0.1.0",
  "description": "Web Audio Playback Engine plugin for @unitrack/core",
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "main": "src/index.js",
  "exports": "./src/index.js",
  "scripts": {
    "test": "node --test \"test/**/*.test.js\"",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@unitrack/core": "^0.1.0",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js"]
}
```

`"lib": ["ES2022", "DOM"]` gives `tsc` the real `Audio`/`AudioContext`/`HTMLAudioElement`/`MediaElementAudioSourceNode`/`MediaError` types this package's JSDoc annotations reference. No `@types/node` — this package has no `node:`-prefixed imports at all.

- [ ] **Step 3: Install from the repo root**

Run (from the repo root, not from inside `packages/engine-web-audio`): `npm install`
Expected: npm recognizes the new workspace package, links `node_modules/@unitrack/core` and `node_modules/@unitrack/engine-web-audio` as workspace symlinks.

- [ ] **Step 4: Write the failing tests**

`packages/engine-web-audio/test/helpers/domStubs.js`:

```js
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
    destination: {},
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
```

`packages/engine-web-audio/test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebAudioPlaybackEngine } from '../src/index.js';
import { createFakeAudioElement, createFakeAudioContext, asConstructor } from './helpers/domStubs.js';

/**
 * @param {any} [audio]
 * @param {any} [audioContext]
 */
function makeEngine(audio = createFakeAudioElement(), audioContext = createFakeAudioContext()) {
  return {
    engine: createWebAudioPlaybackEngine({
      AudioConstructor: asConstructor(audio),
      AudioContextConstructor: asConstructor(audioContext),
    }),
    audio,
    audioContext,
  };
}

test('has the web-audio id', () => {
  const { engine } = makeEngine();
  assert.equal(engine.id, 'web-audio');
});

test('canPlay returns true for a format the browser reports as playable', () => {
  const audio = createFakeAudioElement();
  audio._canPlayTypeResult = 'probably';
  const { engine } = makeEngine(audio);
  assert.equal(engine.canPlay({ url: 'file:///a.mp3', format: 'mp3' }), true);
});

test('canPlay returns false for a mapped format the browser cannot play', () => {
  const audio = createFakeAudioElement();
  audio._canPlayTypeResult = '';
  const { engine } = makeEngine(audio);
  assert.equal(engine.canPlay({ url: 'file:///a.mp3', format: 'mp3' }), false);
});

test('canPlay returns true for an unmapped or missing format', () => {
  const { engine } = makeEngine();
  assert.equal(engine.canPlay({ url: 'file:///a.xyz', format: 'xyz' }), true);
  assert.equal(engine.canPlay({ url: 'file:///a' }), true);
});

test('load sets the audio src and resolves once canplay fires', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const loadPromise = engine.load({ url: 'file:///song.flac', format: 'flac' });
  assert.equal(audio.src, 'file:///song.flac');
  audio._simulateCanPlay(120);
  await loadPromise;
});

test('load rejects with a mapped error message when the element errors', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const loadPromise = engine.load({ url: 'file:///broken.mp3' });
  audio._simulateError(4);
  await assert.rejects(
    () => loadPromise,
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /MEDIA_ERR_SRC_NOT_SUPPORTED/);
      return true;
    }
  );
});

test('play calls through to the audio element', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.play();
  assert.equal(audio.paused, false);
});

test('pause calls through to the audio element', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.play();
  await engine.pause();
  assert.equal(audio.paused, true);
});

test('stop pauses and resets position to 0', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.play();
  audio._simulateTimeUpdate(42);
  await engine.stop();
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0);
});

test('seek sets the audio currentTime', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.seek(30);
  assert.equal(audio.currentTime, 30);
});

test('getState reflects position, duration, and buffering', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  audio._simulateCanPlay(180);
  audio._simulateTimeUpdate(10);
  assert.deepEqual(engine.getState(), { position: 10, duration: 180, buffering: false });
  audio._simulateWaiting();
  assert.equal(engine.getState().buffering, true);
});

test('progress handler fires on timeupdate with position and duration', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const events = [];
  engine.on('progress', (payload) => events.push(payload));
  audio._simulateCanPlay(200);
  audio._simulateTimeUpdate(15);
  assert.deepEqual(events, [{ position: 15, duration: 200 }]);
});

test('ended handler fires on the native ended event', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  let called = false;
  engine.on('ended', () => { called = true; });
  audio._simulateEnded();
  assert.equal(called, true);
});

test('error handler fires with a mapped Error on the native error event', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const errors = [];
  engine.on('error', (err) => errors.push(err));
  audio._simulateError(2);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /MEDIA_ERR_NETWORK/);
});

test('getAudioGraphAnchor returns the media element source node connected to the context destination', () => {
  const audio = createFakeAudioElement();
  const audioContext = createFakeAudioContext();
  const { engine } = makeEngine(audio, audioContext);
  const anchor = engine.getAudioGraphAnchor();
  assert.equal(anchor.audioElement, audio);
  assert.equal(anchor.connectedTo, audioContext.destination);
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -w @unitrack/engine-web-audio` (or `npm test` from inside `packages/engine-web-audio`)
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 6: Implement `createWebAudioPlaybackEngine`**

`packages/engine-web-audio/src/index.js`:

```js
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
```

Three spots needed explicit typing to satisfy `tsc --checkJs --strict` (the same class of issue found in `source-local-fs`'s plan — code that hadn't been run through the real type-checker before being written into the plan): `MEDIA_ERROR_MESSAGES`/`FORMAT_MIME_TYPES` need `Record<number, string>`/`Record<string, string>` annotations, since indexing a plain object literal with a non-literal `number`/`string` key (`error.code`, `resolved.format`) is flagged as implicit-any without one; and the `new Promise((resolve, reject) => {...})` in `load()` needs an explicit `/** @type {Promise<void>} */` cast, since calling `resolve()` with no arguments across two separate `addEventListener` registrations doesn't let `tsc` infer `Promise<void>` on its own.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w @unitrack/engine-web-audio`
Expected: PASS — all 15 tests pass.

- [ ] **Step 8: Run the typecheck**

Run: `npm run typecheck -w @unitrack/engine-web-audio`
Expected: no errors. If `import('@unitrack/core/types').X` fails to resolve, re-run `npm install` from the repo root first (Step 3).

- [ ] **Step 9: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both delegate into every workspace package (`@unitrack/core`, `@unitrack/source-local-fs`, `@unitrack/engine-web-audio`) and pass — 79 prior tests plus 15 new ones, zero typecheck errors across all three packages.

- [ ] **Step 10: Commit**

```bash
git add packages/engine-web-audio
git commit -m "feat: add @unitrack/engine-web-audio, a Web Audio Playback Engine"
```
