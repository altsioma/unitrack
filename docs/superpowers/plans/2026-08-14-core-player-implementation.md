# Core Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@unitrack/core` package — a headless, plugin-based music player core (domain model, queue, resolution, playback orchestration) as specified in `docs/superpowers/specs/2026-08-13-core-player-design.md`.

**Architecture:** A dependency-free ESM package. `CorePlayer` is the public facade composing a `QueueManager` (linear queue with a current-item pointer), a `PluginRegistry` (holds Source Provider / Playback Engine / Metadata Provider / Playlist Provider plugins), and a pure `resolveTrack` function (turns a `LogicalTrack` + policy into a `ResolvedSource` by trying sources in policy order). State changes are surfaced through a minimal custom `EventEmitter` (no Node/browser built-ins) plus a `getState()` snapshot — no reactive store, no persistence inside Core.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs` (TypeScript used only as a dev-time checker, not a build step). Tests via Node's built-in `node:test` + `node:assert/strict`. Zero runtime dependencies.

## Global Constraints

- Plugins execute in-process as trusted code — no sandboxing, no isolation layer.
- Zero runtime dependencies. `typescript` is a devDependency used only for `tsc --checkJs`; nothing is transpiled or bundled — `.js` files run directly.
- ESM only (`"type": "module"` in `package.json`); target Node >= 18 (required for the stable `node:test` runner).
- The public `CorePlayer` API surface must match the spec exactly: `registerSourceProvider`, `registerPlaybackEngine`, `registerMetadataProvider`, `registerPlaylistProvider`, `setPolicy`, `play`, `pause`, `stop`, `next`, `prev`, `seek`, `getState`, `restoreState`, `on`, `off`, plus a public `queue` property (a `QueueManager` instance) exposing `add`/`remove`/`reorder`/`clear`/`getItems`.
- Events emitted by `CorePlayer`: `stateChanged`, `trackChanged`, `positionChanged` (throttled — at most once per 250ms), `queueChanged`, `error`.
- Core never persists state itself, never automatically skips a track after an unrecoverable error (the host must call `next()`/`play()` itself), and never performs automatic track-identity matching — `LogicalTrack.sources[]` is always supplied by the caller.
- Out of scope for this plan (per spec Non-goals): shuffle, repeat, gapless playback, EQ/DSP interfaces, visualizer interfaces, Identity Provider interface, a universal engine-agnostic audio graph API.
- Every exported class/function gets JSDoc `@param`/`@returns` annotations referencing the shared types in `src/types.js`. `npm run typecheck` must report zero errors at the end of every task, and `npm test` must pass at the end of every task.

---

## Task 1: Project scaffolding & tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/index.js`
- Create: `test/smoke.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm test` (runs `node --test "test/**/*.test.js"`) and `npm run typecheck` (runs `tsc -p tsconfig.json`) as the two commands every later task uses to verify its work. `src/index.js` exists as an empty ESM module that later tasks extend.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@unitrack/core",
  "version": "0.1.0",
  "description": "Headless, plugin-based music player core",
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
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
```

- [ ] **Step 4: Create `src/index.js` placeholder**

```js
export {};
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/typescript` installed, `package-lock.json` created.

- [ ] **Step 6: Write the smoke test**

`test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the test runner executes assertions', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 7: Run the test suite**

Run: `npm test`
Expected: PASS — 1 test passed.

- [ ] **Step 8: Run the typecheck**

Run: `npm run typecheck`
Expected: exits with no errors (checking the placeholder `src/index.js`).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/index.js test/smoke.test.js
git commit -m "chore: scaffold @unitrack/core package with test and typecheck tooling"
```

---

## Task 2: EventEmitter utility

**Files:**
- Create: `src/EventEmitter.js`
- Test: `test/EventEmitter.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export class EventEmitter { on(event: string, handler: Function): void; off(event: string, handler: Function): void; emit(event: string, payload?: any): void; }`. Later tasks (`QueueManager`, `CorePlayer`) `extend` this class to get pub/sub for free.

- [ ] **Step 1: Write the failing tests**

`test/EventEmitter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../src/EventEmitter.js';

test('calls a registered handler on emit with the given payload', () => {
  const emitter = new EventEmitter();
  let received;
  emitter.on('foo', (payload) => { received = payload; });
  emitter.emit('foo', 42);
  assert.equal(received, 42);
});

test('supports multiple handlers for the same event, called in order', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('foo', () => calls.push('a'));
  emitter.on('foo', () => calls.push('b'));
  emitter.emit('foo');
  assert.deepEqual(calls, ['a', 'b']);
});

test('off removes only the specified handler', () => {
  const emitter = new EventEmitter();
  const calls = [];
  const handlerA = () => calls.push('a');
  const handlerB = () => calls.push('b');
  emitter.on('foo', handlerA);
  emitter.on('foo', handlerB);
  emitter.off('foo', handlerA);
  emitter.emit('foo');
  assert.deepEqual(calls, ['b']);
});

test('emit with no listeners for the event does not throw', () => {
  const emitter = new EventEmitter();
  assert.doesNotThrow(() => emitter.emit('nothing'));
});

test('events are isolated from each other', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('foo', () => calls.push('foo'));
  emitter.on('bar', () => calls.push('bar'));
  emitter.emit('foo');
  assert.deepEqual(calls, ['foo']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/EventEmitter.js'`.

- [ ] **Step 3: Implement `EventEmitter`**

`src/EventEmitter.js`:

```js
/**
 * A minimal, dependency-free publish/subscribe primitive.
 * Deliberately not Node's `events.EventEmitter` so Core stays
 * runnable in environments without Node built-ins (e.g. a Tauri webview).
 */
export class EventEmitter {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {void}
   */
  on(event, handler) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(handler);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {void}
   */
  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  /**
   * @param {string} event
   * @param {*} [payload]
   * @returns {void}
   */
  emit(event, payload) {
    for (const handler of this.#listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 5 tests passed (plus the Task 1 smoke test).

- [ ] **Step 5: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/EventEmitter.js test/EventEmitter.test.js
git commit -m "feat: add dependency-free EventEmitter utility"
```

---

## Task 3: Domain types & Queue Manager

**Files:**
- Create: `src/types.js`
- Create: `src/Queue.js`
- Create: `test/helpers/fixtures.js`
- Test: `test/Queue.test.js`

**Interfaces:**
- Consumes: `EventEmitter` from `src/EventEmitter.js` (Task 2) — `class X extends EventEmitter`.
- Produces:
  - `src/types.js` JSDoc typedefs: `SourceRef`, `LogicalTrack`, `QueueItem` (referenced by later tasks as `import('./types.js').<Name>`).
  - `export class QueueManager extends EventEmitter` with methods: `add(trackOrTracks: LogicalTrack | LogicalTrack[]): QueueItem[]`, `remove(queueItemId: string): boolean`, `reorder(queueItemId: string, newIndex: number): boolean`, `clear(): void`, `getItems(): QueueItem[]`, `getCurrentItem(): QueueItem | undefined`, `getCurrentIndex(): number`, `moveNext(): boolean`, `movePrevious(): boolean`, `setCurrentIndex(index: number): void` (throws `RangeError` if out of bounds). Emits `'changed'` (no payload) on every mutation.
  - `test/helpers/fixtures.js`: `export function makeTrack(id: string, sources?: SourceRef[]): LogicalTrack` — reused by Tasks 4, 6, 7.

- [ ] **Step 1: Create the domain types**

`src/types.js`:

```js
/**
 * @typedef {Object} SourceRef
 * @property {string} pluginId
 * @property {string} sourceId
 * @property {string} kind
 */

/**
 * @typedef {Object} LogicalTrack
 * @property {string} id
 * @property {{ artist: string, album: string, title: string, duration?: number }} metadata
 * @property {SourceRef[]} sources
 */

/**
 * @typedef {Object} QueueItem
 * @property {string} queueItemId
 * @property {LogicalTrack} track
 */

export {};
```

- [ ] **Step 2: Create the track fixture helper**

`test/helpers/fixtures.js`:

```js
/**
 * @param {string} id
 * @param {import('../../src/types.js').SourceRef[]} [sources]
 * @returns {import('../../src/types.js').LogicalTrack}
 */
export function makeTrack(id, sources = []) {
  return { id, metadata: { artist: 'Artist', album: 'Album', title: id }, sources };
}
```

- [ ] **Step 3: Write the failing tests**

`test/Queue.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueManager } from '../src/Queue.js';
import { makeTrack } from './helpers/fixtures.js';

test('add appends a single track and returns a queue item with a track reference', () => {
  const queue = new QueueManager();
  const [item] = queue.add(makeTrack('t1'));
  assert.equal(queue.getItems().length, 1);
  assert.equal(item.track.id, 't1');
  assert.equal(typeof item.queueItemId, 'string');
});

test('add assigns a unique queueItemId even for the same track added twice', () => {
  const queue = new QueueManager();
  const [item1] = queue.add(makeTrack('t1'));
  const [item2] = queue.add(makeTrack('t1'));
  assert.notEqual(item1.queueItemId, item2.queueItemId);
});

test('add accepts an array of tracks', () => {
  const queue = new QueueManager();
  const items = queue.add([makeTrack('t1'), makeTrack('t2')]);
  assert.equal(items.length, 2);
  assert.equal(queue.getItems().length, 2);
});

test('getItems returns a copy, not the live internal array', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('t1'));
  const items = queue.getItems();
  items.pop();
  assert.equal(queue.getItems().length, 1);
});

test('remove deletes an item by queueItemId and returns true', () => {
  const queue = new QueueManager();
  const [item] = queue.add(makeTrack('t1'));
  assert.equal(queue.remove(item.queueItemId), true);
  assert.equal(queue.getItems().length, 0);
});

test('remove returns false for an unknown queueItemId', () => {
  const queue = new QueueManager();
  assert.equal(queue.remove('does-not-exist'), false);
});

test('removing an item before the current index shifts the current index left', () => {
  const queue = new QueueManager();
  const [a] = queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  queue.remove(a.queueItemId);
  assert.equal(queue.getCurrentItem().track.id, 'b');
  assert.equal(queue.getCurrentIndex(), 0);
});

test('removing the last remaining item resets the current index to -1', () => {
  const queue = new QueueManager();
  const [a] = queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  queue.remove(a.queueItemId);
  assert.equal(queue.getCurrentIndex(), -1);
  assert.equal(queue.getCurrentItem(), undefined);
});

test('reorder moves an item to a new index and keeps tracking the current item', () => {
  const queue = new QueueManager();
  const [a, , c] = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(2);
  queue.reorder(a.queueItemId, 2);
  assert.deepEqual(queue.getItems().map((i) => i.track.id), ['b', 'c', 'a']);
  assert.equal(queue.getCurrentItem().track.id, 'c');
});

test('reorder returns false for an unknown queueItemId', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  assert.equal(queue.reorder('does-not-exist', 0), false);
});

test('clear empties the queue and resets the current index', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  queue.clear();
  assert.equal(queue.getItems().length, 0);
  assert.equal(queue.getCurrentIndex(), -1);
});

test('moveNext advances the current index and returns true', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  assert.equal(queue.moveNext(), true);
  assert.equal(queue.getCurrentItem().track.id, 'a');
  assert.equal(queue.moveNext(), true);
  assert.equal(queue.getCurrentItem().track.id, 'b');
});

test('moveNext returns false at the end of the queue and does not move', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.moveNext();
  assert.equal(queue.moveNext(), false);
  assert.equal(queue.getCurrentItem().track.id, 'a');
});

test('movePrevious retreats the current index and returns true', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  assert.equal(queue.movePrevious(), true);
  assert.equal(queue.getCurrentItem().track.id, 'a');
});

test('movePrevious returns false at the start of the queue', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  assert.equal(queue.movePrevious(), false);
});

test('setCurrentIndex throws a RangeError for an out-of-bounds index', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  assert.throws(() => queue.setCurrentIndex(5), RangeError);
  assert.throws(() => queue.setCurrentIndex(-2), RangeError);
});

test('setCurrentIndex(-1) is valid and clears the current item', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  queue.setCurrentIndex(-1);
  assert.equal(queue.getCurrentItem(), undefined);
});

test('emits changed on every mutating operation', () => {
  const queue = new QueueManager();
  let fired = 0;
  queue.on('changed', () => { fired += 1; });
  const [item] = queue.add(makeTrack('a'));
  queue.add(makeTrack('b'));
  queue.moveNext();
  queue.movePrevious();
  queue.setCurrentIndex(1);
  queue.reorder(item.queueItemId, 1);
  queue.remove(item.queueItemId);
  queue.clear();
  assert.equal(fired, 8);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/Queue.js'`.

- [ ] **Step 5: Implement `QueueManager`**

`src/Queue.js`:

```js
import { EventEmitter } from './EventEmitter.js';

let nextQueueItemId = 1;

/** @extends {EventEmitter} */
export class QueueManager extends EventEmitter {
  /** @type {import('./types.js').QueueItem[]} */
  #items = [];
  /** @type {number} */
  #currentIndex = -1;

  /**
   * @param {import('./types.js').LogicalTrack | import('./types.js').LogicalTrack[]} trackOrTracks
   * @returns {import('./types.js').QueueItem[]}
   */
  add(trackOrTracks) {
    const tracks = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
    const newItems = tracks.map((track) => ({ queueItemId: `qi_${nextQueueItemId++}`, track }));
    this.#items.push(...newItems);
    this.emit('changed');
    return newItems;
  }

  /**
   * @param {string} queueItemId
   * @returns {boolean}
   */
  remove(queueItemId) {
    const idx = this.#items.findIndex((i) => i.queueItemId === queueItemId);
    if (idx === -1) return false;
    this.#items.splice(idx, 1);
    if (this.#items.length === 0) {
      this.#currentIndex = -1;
    } else if (idx < this.#currentIndex) {
      this.#currentIndex -= 1;
    } else if (idx === this.#currentIndex && this.#currentIndex >= this.#items.length) {
      this.#currentIndex = this.#items.length - 1;
    }
    this.emit('changed');
    return true;
  }

  /**
   * @param {string} queueItemId
   * @param {number} newIndex
   * @returns {boolean}
   */
  reorder(queueItemId, newIndex) {
    const idx = this.#items.findIndex((i) => i.queueItemId === queueItemId);
    if (idx === -1) return false;
    const clampedIndex = Math.max(0, Math.min(newIndex, this.#items.length - 1));
    const currentItemId = this.#currentIndex >= 0 ? this.#items[this.#currentIndex].queueItemId : null;
    const [item] = this.#items.splice(idx, 1);
    this.#items.splice(clampedIndex, 0, item);
    this.#currentIndex = currentItemId
      ? this.#items.findIndex((i) => i.queueItemId === currentItemId)
      : -1;
    this.emit('changed');
    return true;
  }

  /** @returns {void} */
  clear() {
    this.#items = [];
    this.#currentIndex = -1;
    this.emit('changed');
  }

  /** @returns {import('./types.js').QueueItem[]} */
  getItems() {
    return [...this.#items];
  }

  /** @returns {import('./types.js').QueueItem | undefined} */
  getCurrentItem() {
    return this.#currentIndex >= 0 ? this.#items[this.#currentIndex] : undefined;
  }

  /** @returns {number} */
  getCurrentIndex() {
    return this.#currentIndex;
  }

  /** @returns {boolean} */
  moveNext() {
    if (this.#currentIndex + 1 >= this.#items.length) return false;
    this.#currentIndex += 1;
    this.emit('changed');
    return true;
  }

  /** @returns {boolean} */
  movePrevious() {
    if (this.#currentIndex <= 0) return false;
    this.#currentIndex -= 1;
    this.emit('changed');
    return true;
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  setCurrentIndex(index) {
    if (index < -1 || index >= this.#items.length) {
      throw new RangeError(`Index out of bounds: ${index}`);
    }
    this.#currentIndex = index;
    this.emit('changed');
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all Queue tests pass, plus prior tasks' tests.

- [ ] **Step 7: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.js src/Queue.js test/helpers/fixtures.js test/Queue.test.js
git commit -m "feat: add domain types and linear QueueManager"
```

---

## Task 4: Track resolution (Resolver + policy)

**Files:**
- Modify: `src/types.js` (append `ResolvedSource`, `SourcePolicyRule`, `SourceProvider`)
- Create: `src/Resolver.js`
- Create: `test/helpers/mockPlugins.js`
- Test: `test/Resolver.test.js`

**Interfaces:**
- Consumes: `LogicalTrack`, `SourceRef` from `src/types.js` (Task 3); `makeTrack` from `test/helpers/fixtures.js` (Task 3).
- Produces:
  - `export class TrackResolutionError extends Error` with `.trackId: string` and `.failedSources: Array<{ pluginId: string, sourceId: string, reason: string }>`.
  - `export async function resolveTrack(track: LogicalTrack, policy: SourcePolicyRule[], providers: SourceProvider[]): Promise<ResolvedSource>` — throws `TrackResolutionError` if nothing resolves. Used by `CorePlayer` in Task 7.
  - `test/helpers/mockPlugins.js`: `export function createMockSourceProvider({ id, kind, resolveImpl, canResolveImpl }): SourceProvider`.

- [ ] **Step 1: Append resolution-related types**

Append to `src/types.js` (before the trailing `export {};`):

```js
/**
 * @typedef {Object} ResolvedSource
 * @property {string} url
 * @property {string} [format]
 * @property {number} [bitrate]
 */

/**
 * @typedef {Object} SourcePolicyRule
 * @property {string} [kind]
 * @property {string} [pluginId]
 */

/**
 * @typedef {Object} SourceProvider
 * @property {string} id
 * @property {string} kind
 * @property {(ref: SourceRef) => boolean} canResolve
 * @property {(ref: SourceRef) => Promise<ResolvedSource>} resolve
 * @property {() => Promise<void>} [dispose]
 */
```

- [ ] **Step 2: Create the mock Source Provider factory**

`test/helpers/mockPlugins.js`:

```js
/**
 * @param {{ id: string, kind: string, resolveImpl: (ref: import('../../src/types.js').SourceRef) => Promise<import('../../src/types.js').ResolvedSource>, canResolveImpl?: (ref: import('../../src/types.js').SourceRef) => boolean }} config
 * @returns {import('../../src/types.js').SourceProvider}
 */
export function createMockSourceProvider({ id, kind, resolveImpl, canResolveImpl }) {
  return {
    id,
    kind,
    canResolve: canResolveImpl ?? (() => true),
    resolve: resolveImpl,
  };
}
```

- [ ] **Step 3: Write the failing tests**

`test/Resolver.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrack, TrackResolutionError } from '../src/Resolver.js';
import { createMockSourceProvider } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('resolves via the first matching policy rule and source', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const streaming = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://spotify/track' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'spotify', sourceId: 's1', kind: 'streaming' },
    { pluginId: 'local-fs', sourceId: 'l1', kind: 'local' },
  ]);
  const policy = [{ kind: 'local' }, { kind: 'streaming' }];
  const resolved = await resolveTrack(track, policy, [local, streaming]);
  assert.deepEqual(resolved, { url: 'file:///a.flac' });
});

test('falls back to the next source within the same rule when resolve rejects', async () => {
  const failing = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const working = createMockSourceProvider({
    id: 'local-fs-2', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///b.flac' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', sourceId: 'l1', kind: 'local' },
    { pluginId: 'local-fs-2', sourceId: 'l2', kind: 'local' },
  ]);
  const resolved = await resolveTrack(track, [{ kind: 'local' }], [failing, working]);
  assert.deepEqual(resolved, { url: 'file:///b.flac' });
});

test('falls back to the next rule when no source in the current rule resolves', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const streaming = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://spotify/track' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'local-fs', sourceId: 'l1', kind: 'local' },
    { pluginId: 'spotify', sourceId: 's1', kind: 'streaming' },
  ]);
  const policy = [{ kind: 'local' }, { kind: 'streaming' }];
  const resolved = await resolveTrack(track, policy, [local, streaming]);
  assert.deepEqual(resolved, { url: 'https://spotify/track' });
});

test('respects a pluginId-specific rule over other providers of the same kind', async () => {
  const spotify = createMockSourceProvider({
    id: 'spotify', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://spotify/track' }),
  });
  const tidal = createMockSourceProvider({
    id: 'tidal', kind: 'streaming',
    resolveImpl: async () => ({ url: 'https://tidal/track' }),
  });
  const track = makeTrack('t1', [
    { pluginId: 'tidal', sourceId: 't1', kind: 'streaming' },
    { pluginId: 'spotify', sourceId: 's1', kind: 'streaming' },
  ]);
  const resolved = await resolveTrack(track, [{ kind: 'streaming', pluginId: 'spotify' }], [spotify, tidal]);
  assert.deepEqual(resolved, { url: 'https://spotify/track' });
});

test('records a failure and skips a source whose provider is not registered', async () => {
  const track = makeTrack('t1', [{ pluginId: 'missing-plugin', sourceId: 'x1', kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], []),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        { pluginId: 'missing-plugin', sourceId: 'x1', reason: 'no provider registered for pluginId' },
      ]);
      return true;
    }
  );
});

test('records a failure and skips a source the provider declines via canResolve', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
    canResolveImpl: () => false,
  });
  const track = makeTrack('t1', [{ pluginId: 'local-fs', sourceId: 'l1', kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [provider]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.deepEqual(err.failedSources, [
        { pluginId: 'local-fs', sourceId: 'l1', reason: 'provider cannot resolve this source' },
      ]);
      return true;
    }
  );
});

test('throws TrackResolutionError with the track id and all failure reasons when nothing resolves', async () => {
  const local = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  const track = makeTrack('t1', [{ pluginId: 'local-fs', sourceId: 'l1', kind: 'local' }]);
  await assert.rejects(
    () => resolveTrack(track, [{ kind: 'local' }], [local]),
    (err) => {
      assert.ok(err instanceof TrackResolutionError);
      assert.equal(err.trackId, 't1');
      assert.deepEqual(err.failedSources, [
        { pluginId: 'local-fs', sourceId: 'l1', reason: 'file missing' },
      ]);
      return true;
    }
  );
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/Resolver.js'`.

- [ ] **Step 5: Implement `resolveTrack` and `TrackResolutionError`**

`src/Resolver.js`:

```js
/**
 * @extends {Error}
 */
export class TrackResolutionError extends Error {
  /**
   * @param {string} trackId
   * @param {Array<{ pluginId: string, sourceId: string, reason: string }>} failedSources
   */
  constructor(trackId, failedSources) {
    super(`Failed to resolve track ${trackId}`);
    this.name = 'TrackResolutionError';
    this.trackId = trackId;
    this.failedSources = failedSources;
  }
}

/**
 * @param {import('./types.js').LogicalTrack} track
 * @param {import('./types.js').SourcePolicyRule[]} policy
 * @param {import('./types.js').SourceProvider[]} providers
 * @returns {Promise<import('./types.js').ResolvedSource>}
 */
export async function resolveTrack(track, policy, providers) {
  /** @type {Array<{ pluginId: string, sourceId: string, reason: string }>} */
  const failedSources = [];

  for (const rule of policy) {
    const matchingRefs = track.sources.filter((ref) =>
      (!rule.kind || ref.kind === rule.kind) &&
      (!rule.pluginId || ref.pluginId === rule.pluginId)
    );

    for (const ref of matchingRefs) {
      const provider = providers.find((p) => p.id === ref.pluginId);
      if (!provider) {
        failedSources.push({ pluginId: ref.pluginId, sourceId: ref.sourceId, reason: 'no provider registered for pluginId' });
        continue;
      }
      if (!provider.canResolve(ref)) {
        failedSources.push({ pluginId: ref.pluginId, sourceId: ref.sourceId, reason: 'provider cannot resolve this source' });
        continue;
      }
      try {
        return await provider.resolve(ref);
      } catch (err) {
        failedSources.push({
          pluginId: ref.pluginId,
          sourceId: ref.sourceId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  throw new TrackResolutionError(track.id, failedSources);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all Resolver tests pass, plus prior tasks' tests.

- [ ] **Step 7: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.js src/Resolver.js test/helpers/mockPlugins.js test/Resolver.test.js
git commit -m "feat: add ordered-fallback source resolution"
```

---

## Task 5: Plugin Registry

**Files:**
- Modify: `src/types.js` (append `EngineState`, `PlaybackEngine`, `MetadataQuery`, `TrackMetadata`, `MetadataProvider`, `PlaylistRef`, `PlaylistSummary`, `PlaylistProvider`)
- Create: `src/PluginRegistry.js`
- Modify: `test/helpers/mockPlugins.js` (append `createMockPlaybackEngine`)
- Test: `test/PluginRegistry.test.js`

**Interfaces:**
- Consumes: `ResolvedSource` from `src/types.js` (Task 4); `createMockSourceProvider` from `test/helpers/mockPlugins.js` (Task 4).
- Produces: `export class PluginRegistry` with:
  - `registerSourceProvider(plugin: SourceProvider): void` (throws if `plugin.id` already registered)
  - `getSourceProvider(id: string): SourceProvider | undefined`
  - `getSourceProviders(): SourceProvider[]`
  - `registerPlaybackEngine(plugin: PlaybackEngine): void` (throws if `plugin.id` already registered)
  - `getPlaybackEngineFor(resolved: ResolvedSource): PlaybackEngine | undefined` — first registered engine whose `canPlay(resolved)` returns true
  - `registerMetadataProvider(plugin: MetadataProvider): void`, `getMetadataProvider(id): MetadataProvider | undefined`, `getMetadataProviders(): MetadataProvider[]`
  - `registerPlaylistProvider(plugin: PlaylistProvider): void`, `getPlaylistProvider(id): PlaylistProvider | undefined`, `getPlaylistProviders(): PlaylistProvider[]`
  - Used directly by `CorePlayer` in Tasks 6–7.
  - `test/helpers/mockPlugins.js` addition: `export function createMockPlaybackEngine({ id, canPlayImpl }): PlaybackEngine & { loaded, playCalls, pauseCalls, stopCalls, seekCalls, _simulate(event, payload) }`.

- [ ] **Step 1: Append plugin-interface types**

Append to `src/types.js` (before the trailing `export {};`):

```js
/**
 * @typedef {Object} EngineState
 * @property {number} position
 * @property {number} duration
 * @property {boolean} buffering
 */

/**
 * @typedef {Object} PlaybackEngine
 * @property {string} id
 * @property {(resolved: ResolvedSource) => boolean} canPlay
 * @property {(resolved: ResolvedSource) => Promise<void>} load
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} stop
 * @property {(seconds: number) => Promise<void>} seek
 * @property {() => EngineState} getState
 * @property {(event: 'ended'|'error'|'progress', handler: (payload?: any) => void) => void} on
 * @property {() => any} [getAudioGraphAnchor]
 */

/**
 * @typedef {Object} MetadataQuery
 * @property {string} [artist]
 * @property {string} [title]
 */

/**
 * @typedef {Object} TrackMetadata
 * @property {string} artist
 * @property {string} album
 * @property {string} title
 * @property {number} [duration]
 * @property {string} [coverArtUrl]
 */

/**
 * @typedef {Object} MetadataProvider
 * @property {string} id
 * @property {(query: MetadataQuery) => Promise<TrackMetadata[]>} search
 * @property {(ref: SourceRef) => Promise<TrackMetadata>} [fetchForSource]
 */

/**
 * @typedef {Object} PlaylistRef
 * @property {string} pluginId
 * @property {string} playlistId
 */

/**
 * @typedef {Object} PlaylistSummary
 * @property {string} playlistId
 * @property {string} name
 */

/**
 * @typedef {Object} PlaylistProvider
 * @property {string} id
 * @property {(playlistRef: PlaylistRef) => Promise<LogicalTrack[]>} fetchPlaylist
 * @property {() => Promise<PlaylistSummary[]>} [listPlaylists]
 */
```

- [ ] **Step 2: Add the mock Playback Engine factory**

Append to `test/helpers/mockPlugins.js`:

```js
/**
 * @param {{ id?: string, canPlayImpl?: (resolved: import('../../src/types.js').ResolvedSource) => boolean }} [config]
 * @returns {import('../../src/types.js').PlaybackEngine & { loaded: any, playCalls: number, pauseCalls: number, stopCalls: number, seekCalls: number[], _simulate: (event: string, payload?: any) => void }}
 */
export function createMockPlaybackEngine({ id, canPlayImpl } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  return {
    id: id ?? 'mock-engine',
    canPlay: canPlayImpl ?? (() => true),
    loaded: null,
    playCalls: 0,
    pauseCalls: 0,
    stopCalls: 0,
    seekCalls: [],
    async load(resolved) { this.loaded = resolved; },
    async play() { this.playCalls += 1; },
    async pause() { this.pauseCalls += 1; },
    async stop() { this.stopCalls += 1; },
    async seek(seconds) { this.seekCalls.push(seconds); },
    getState() { return { position: 0, duration: 0, buffering: false }; },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    _simulate(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
}
```

- [ ] **Step 3: Write the failing tests**

`test/PluginRegistry.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../src/PluginRegistry.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';

test('registers and looks up a source provider by id', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ url: 'x' }) });
  registry.registerSourceProvider(provider);
  assert.equal(registry.getSourceProvider('local-fs'), provider);
  assert.deepEqual(registry.getSourceProviders(), [provider]);
});

test('throws when registering a source provider with a duplicate id', () => {
  const registry = new PluginRegistry();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ url: 'x' }) });
  registry.registerSourceProvider(provider);
  assert.throws(() => registry.registerSourceProvider(provider), /already registered/);
});

test('getPlaybackEngineFor returns the first registered engine whose canPlay matches', () => {
  const registry = new PluginRegistry();
  const noMatch = createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: () => false });
  const match = createMockPlaybackEngine({ id: 'engine-b', canPlayImpl: () => true });
  registry.registerPlaybackEngine(noMatch);
  registry.registerPlaybackEngine(match);
  assert.equal(registry.getPlaybackEngineFor({ url: 'x' }), match);
});

test('getPlaybackEngineFor returns undefined when no engine matches', () => {
  const registry = new PluginRegistry();
  registry.registerPlaybackEngine(createMockPlaybackEngine({ id: 'engine-a', canPlayImpl: () => false }));
  assert.equal(registry.getPlaybackEngineFor({ url: 'x' }), undefined);
});

test('throws when registering a playback engine with a duplicate id', () => {
  const registry = new PluginRegistry();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  registry.registerPlaybackEngine(engine);
  assert.throws(() => registry.registerPlaybackEngine(engine), /already registered/);
});

test('registers and looks up a metadata provider by id', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'musicbrainz', search: async () => [] };
  registry.registerMetadataProvider(provider);
  assert.equal(registry.getMetadataProvider('musicbrainz'), provider);
  assert.deepEqual(registry.getMetadataProviders(), [provider]);
});

test('registers and looks up a playlist provider by id', () => {
  const registry = new PluginRegistry();
  const provider = { id: 'local-playlists', fetchPlaylist: async () => [] };
  registry.registerPlaylistProvider(provider);
  assert.equal(registry.getPlaylistProvider('local-playlists'), provider);
  assert.deepEqual(registry.getPlaylistProviders(), [provider]);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/PluginRegistry.js'`.

- [ ] **Step 5: Implement `PluginRegistry`**

`src/PluginRegistry.js`:

```js
export class PluginRegistry {
  /** @type {Map<string, import('./types.js').SourceProvider>} */
  #sourceProviders = new Map();
  /** @type {import('./types.js').PlaybackEngine[]} */
  #playbackEngines = [];
  /** @type {Map<string, import('./types.js').MetadataProvider>} */
  #metadataProviders = new Map();
  /** @type {Map<string, import('./types.js').PlaylistProvider>} */
  #playlistProviders = new Map();

  /**
   * @param {import('./types.js').SourceProvider} plugin
   * @returns {void}
   */
  registerSourceProvider(plugin) {
    if (this.#sourceProviders.has(plugin.id)) {
      throw new Error(`Source provider already registered: ${plugin.id}`);
    }
    this.#sourceProviders.set(plugin.id, plugin);
  }

  /** @param {string} id @returns {import('./types.js').SourceProvider | undefined} */
  getSourceProvider(id) {
    return this.#sourceProviders.get(id);
  }

  /** @returns {import('./types.js').SourceProvider[]} */
  getSourceProviders() {
    return Array.from(this.#sourceProviders.values());
  }

  /**
   * @param {import('./types.js').PlaybackEngine} plugin
   * @returns {void}
   */
  registerPlaybackEngine(plugin) {
    if (this.#playbackEngines.some((e) => e.id === plugin.id)) {
      throw new Error(`Playback engine already registered: ${plugin.id}`);
    }
    this.#playbackEngines.push(plugin);
  }

  /**
   * @param {import('./types.js').ResolvedSource} resolved
   * @returns {import('./types.js').PlaybackEngine | undefined}
   */
  getPlaybackEngineFor(resolved) {
    return this.#playbackEngines.find((e) => e.canPlay(resolved));
  }

  /**
   * @param {import('./types.js').MetadataProvider} plugin
   * @returns {void}
   */
  registerMetadataProvider(plugin) {
    if (this.#metadataProviders.has(plugin.id)) {
      throw new Error(`Metadata provider already registered: ${plugin.id}`);
    }
    this.#metadataProviders.set(plugin.id, plugin);
  }

  /** @param {string} id @returns {import('./types.js').MetadataProvider | undefined} */
  getMetadataProvider(id) {
    return this.#metadataProviders.get(id);
  }

  /** @returns {import('./types.js').MetadataProvider[]} */
  getMetadataProviders() {
    return Array.from(this.#metadataProviders.values());
  }

  /**
   * @param {import('./types.js').PlaylistProvider} plugin
   * @returns {void}
   */
  registerPlaylistProvider(plugin) {
    if (this.#playlistProviders.has(plugin.id)) {
      throw new Error(`Playlist provider already registered: ${plugin.id}`);
    }
    this.#playlistProviders.set(plugin.id, plugin);
  }

  /** @param {string} id @returns {import('./types.js').PlaylistProvider | undefined} */
  getPlaylistProvider(id) {
    return this.#playlistProviders.get(id);
  }

  /** @returns {import('./types.js').PlaylistProvider[]} */
  getPlaylistProviders() {
    return Array.from(this.#playlistProviders.values());
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all PluginRegistry tests pass, plus prior tasks' tests.

- [ ] **Step 7: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.js src/PluginRegistry.js test/helpers/mockPlugins.js test/PluginRegistry.test.js
git commit -m "feat: add plugin registry for source providers, playback engines, metadata and playlist providers"
```

---

## Task 6: CorePlayer skeleton — state, events, registration

**Files:**
- Modify: `src/types.js` (append `PlayerStatus`, `CoreState`)
- Create: `src/CorePlayer.js`
- Test: `test/CorePlayer.test.js`

**Interfaces:**
- Consumes:
  - `EventEmitter` from `src/EventEmitter.js` (Task 2).
  - `QueueManager` from `src/Queue.js` (Task 3), specifically `queue.add`, `queue.setCurrentIndex`, `queue.getItems`, `queue.getCurrentItem`, `queue.on('changed', ...)`.
  - `PluginRegistry` from `src/PluginRegistry.js` (Task 5), specifically `registerSourceProvider`, `registerPlaybackEngine`, `registerMetadataProvider`, `registerPlaylistProvider`.
  - `makeTrack` from `test/helpers/fixtures.js` (Task 3); `createMockSourceProvider`, `createMockPlaybackEngine` from `test/helpers/mockPlugins.js` (Tasks 4–5).
- Produces: `export class CorePlayer extends EventEmitter` with a public `queue: QueueManager` property, `registerSourceProvider(plugin)`, `registerPlaybackEngine(plugin)`, `registerMetadataProvider(plugin)`, `registerPlaylistProvider(plugin)`, `setPolicy(policyRules: SourcePolicyRule[]): void`, `getState(): CoreState`, `restoreState(snapshot: CoreState): void`. Playback methods (`play`/`pause`/`stop`/`next`/`prev`/`seek`) are added in Task 7 — this task establishes the class shape and internal fields (`#registry`, `#policy`, `#status`, `#position`, `#duration`) that Task 7 extends.

- [ ] **Step 1: Append state-shape types**

Append to `src/types.js` (before the trailing `export {};`):

```js
/**
 * @typedef {'idle' | 'loading' | 'playing' | 'paused' | 'error'} PlayerStatus
 */

/**
 * @typedef {Object} CoreState
 * @property {PlayerStatus} status
 * @property {QueueItem | undefined} currentQueueItem
 * @property {number} position
 * @property {number} duration
 * @property {QueueItem[]} queue
 * @property {SourcePolicyRule[]} policy
 */
```

- [ ] **Step 2: Write the failing tests**

`test/CorePlayer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorePlayer } from '../src/CorePlayer.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('registerSourceProvider delegates to the internal registry (duplicate id throws)', () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => ({ url: 'x' }) });
  core.registerSourceProvider(provider);
  assert.throws(() => core.registerSourceProvider(provider), /already registered/);
});

test('registerPlaybackEngine delegates to the internal registry (duplicate id throws)', () => {
  const core = new CorePlayer();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerPlaybackEngine(engine);
  assert.throws(() => core.registerPlaybackEngine(engine), /already registered/);
});

test('registerMetadataProvider and registerPlaylistProvider delegate without throwing', () => {
  const core = new CorePlayer();
  assert.doesNotThrow(() => core.registerMetadataProvider({ id: 'mb', search: async () => [] }));
  assert.doesNotThrow(() => core.registerPlaylistProvider({ id: 'local', fetchPlaylist: async () => [] }));
});

test('queue mutations emit queueChanged on the core instance', () => {
  const core = new CorePlayer();
  let fired = 0;
  core.on('queueChanged', () => { fired += 1; });
  core.queue.add(makeTrack('t1'));
  assert.equal(fired, 1);
});

test('getState reflects the queue, policy, and default idle status', () => {
  const core = new CorePlayer();
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(makeTrack('t1'));
  const state = core.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.queue.length, 1);
  assert.deepEqual(state.policy, [{ kind: 'local' }]);
  assert.equal(state.currentQueueItem, undefined);
  assert.equal(state.position, 0);
  assert.equal(state.duration, 0);
});

test('restoreState rebuilds the queue in order and preserves the current item', () => {
  const core = new CorePlayer();
  core.queue.add([makeTrack('t1'), makeTrack('t2')]);
  core.queue.setCurrentIndex(1);
  const snapshot = core.getState();

  const restored = new CorePlayer();
  restored.restoreState(snapshot);
  const restoredState = restored.getState();
  assert.equal(restoredState.queue.length, 2);
  assert.equal(restoredState.queue[0].track.id, 't1');
  assert.equal(restoredState.queue[1].track.id, 't2');
  assert.equal(restoredState.currentQueueItem.track.id, 't2');
  assert.deepEqual(restoredState.policy, snapshot.policy);
  assert.equal(restoredState.status, 'idle');
});

test('restoreState with no current item leaves the queue unselected', () => {
  const core = new CorePlayer();
  core.queue.add(makeTrack('t1'));
  const snapshot = core.getState();

  const restored = new CorePlayer();
  restored.restoreState(snapshot);
  assert.equal(restored.getState().currentQueueItem, undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/CorePlayer.js'`.

- [ ] **Step 4: Implement the `CorePlayer` skeleton**

`src/CorePlayer.js`:

```js
import { EventEmitter } from './EventEmitter.js';
import { QueueManager } from './Queue.js';
import { PluginRegistry } from './PluginRegistry.js';

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

  constructor() {
    super();
    this.queue.on('changed', () => this.emit('queueChanged'));
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
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all CorePlayer skeleton tests pass, plus prior tasks' tests.

- [ ] **Step 6: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.js src/CorePlayer.js test/CorePlayer.test.js
git commit -m "feat: add CorePlayer skeleton with registration, state snapshot, and restore"
```

---

## Task 7: CorePlayer playback orchestration

**Files:**
- Modify: `src/CorePlayer.js` (add playback methods and engine binding)
- Modify: `test/CorePlayer.test.js` (append playback orchestration tests)

**Interfaces:**
- Consumes:
  - `resolveTrack`, `TrackResolutionError` from `src/Resolver.js` (Task 4).
  - Everything already on `CorePlayer` from Task 6: `#registry` (`PluginRegistry`, with `getSourceProviders()` and `getPlaybackEngineFor()`), `queue` (`QueueManager`, with `moveNext()`, `movePrevious()`, `getCurrentItem()`, `setCurrentIndex()`), `#policy`, `#status`, `#position`, `#duration`, and the inherited `emit()`.
  - `createMockPlaybackEngine`'s `_simulate(event, payload)` from `test/helpers/mockPlugins.js` (Task 5), to fire `'progress'`, `'ended'`, `'error'` in tests.
- Produces: `play(): Promise<void>`, `pause(): Promise<void>`, `stop(): Promise<void>`, `next(): Promise<void>`, `prev(): Promise<void>`, `seek(seconds: number): Promise<void>` on `CorePlayer`. None of these throw on resolution/playback failure — failures surface only via the `'error'` event and `status: 'error'`, per the spec's error-handling decision. This is the last task that touches playback behavior; Task 8 only wires the public entry point.

- [ ] **Step 1: Write the failing tests**

Append to `test/CorePlayer.test.js`:

```js
function trackWithLocalSource(id, sourceId = `${id}-src`) {
  return makeTrack(id, [{ pluginId: 'local-fs', sourceId, kind: 'local' }]);
}

test('play resolves the current track and starts the engine', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item));

  await core.play();

  assert.equal(core.getState().status, 'playing');
  assert.deepEqual(engine.loaded, { url: 'file:///a.flac' });
  assert.equal(engine.playCalls, 1);
  assert.equal(trackChanged.length, 1);
  assert.equal(trackChanged[0].track.id, 't1');
});

test('play on an empty queue is a no-op', async () => {
  const core = new CorePlayer();
  await core.play();
  assert.equal(core.getState().status, 'idle');
});

test('play emits an error and stops when resolution fails for every source', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => { throw new Error('file missing'); },
  });
  core.registerSourceProvider(provider);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].trackId, 't1');
  assert.deepEqual(errors[0].failedSources, [
    { pluginId: 'local-fs', sourceId: 't1-src', reason: 'file missing' },
  ]);
});

test('play emits an error when no registered engine can play the resolved source', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio', canPlayImpl: () => false });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await core.play();

  assert.equal(core.getState().status, 'error');
  assert.equal(errors[0].reason, 'no playback engine registered for resolved source');
});

test('pause and resume do not re-resolve or reload the track', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  await core.play();
  await core.pause();
  assert.equal(core.getState().status, 'paused');
  assert.equal(engine.pauseCalls, 1);

  await core.play();
  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.playCalls, 2);
});

test('stop resets status and position without clearing the queue', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  await core.play();
  await core.stop();

  const state = core.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.position, 0);
  assert.equal(state.queue.length, 1);
  assert.equal(engine.stopCalls, 1);
});

test('next loads and plays the following queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.deepEqual(engine.loaded, { url: 'file:///l2.flac' });
});

test('next is a no-op at the end of the queue', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  await core.play();
  await core.next();

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.equal(engine.playCalls, 1);
});

test('prev loads and plays the preceding queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);

  await core.play();
  await core.next();
  await core.prev();

  assert.equal(core.getState().currentQueueItem.track.id, 't1');
  assert.deepEqual(engine.loaded, { url: 'file:///l1.flac' });
});

test('seek delegates to the active engine only once a track is loaded', async () => {
  const core = new CorePlayer();
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerPlaybackEngine(engine);

  await core.seek(30);
  assert.deepEqual(engine.seekCalls, []);

  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  core.registerSourceProvider(provider);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();
  await core.seek(30);
  assert.deepEqual(engine.seekCalls, [30]);
});

test('engine progress events emit a throttled positionChanged', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  const positions = [];
  core.on('positionChanged', (payload) => positions.push(payload));

  engine._simulate('progress', { position: 1, duration: 100 });
  engine._simulate('progress', { position: 2, duration: 100 });

  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0], { position: 1, duration: 100 });
});

test('engine ended event auto-advances to the next queue item', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => ({ url: `file:///${ref.sourceId}.flac` }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([trackWithLocalSource('t1', 'l1'), trackWithLocalSource('t2', 'l2')]);
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().currentQueueItem.track.id, 't2');
});

test('engine ended event sets status to idle when the queue is finished', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  engine._simulate('ended');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
});

test('engine error event during playback stops and emits error', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));
  await core.play();

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  engine._simulate('error', new Error('device disconnected'));

  assert.equal(core.getState().status, 'error');
  assert.equal(errors[0].reason, 'device disconnected');
  assert.equal(errors[0].trackId, 't1');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `core.play is not a function`.

- [ ] **Step 3: Implement playback orchestration**

Add this import to the top of `src/CorePlayer.js`:

```js
import { resolveTrack, TrackResolutionError } from './Resolver.js';
```

Add this private field next to the existing ones in the `CorePlayer` class body:

```js
  /** @type {import('./types.js').PlaybackEngine | undefined} */
  #activeEngine;
```

Add these methods to the `CorePlayer` class body (after `restoreState`):

```js
  /** @returns {Promise<void>} */
  async play() {
    if (this.#status === 'playing') return;
    if (this.#status === 'paused' && this.#activeEngine) {
      await this.#activeEngine.play();
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
  async pause() {
    if (this.#status !== 'playing' || !this.#activeEngine) return;
    await this.#activeEngine.pause();
    this.#status = 'paused';
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (this.#activeEngine) await this.#activeEngine.stop();
    this.#status = 'idle';
    this.#position = 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async next() {
    const moved = this.queue.moveNext();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async prev() {
    const moved = this.queue.movePrevious();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @param {number} seconds @returns {Promise<void>} */
  async seek(seconds) {
    if (!this.#activeEngine || this.#status === 'idle' || this.#status === 'error') return;
    await this.#activeEngine.seek(seconds);
  }

  /** @returns {Promise<void>} */
  async #loadAndPlayCurrent() {
    const queueItem = this.queue.getCurrentItem();
    if (!queueItem) return;

    this.#status = 'loading';
    this.#position = 0;
    this.emit('stateChanged');

    /** @type {import('./types.js').ResolvedSource} */
    let resolved;
    try {
      resolved = await resolveTrack(queueItem.track, this.#policy, this.#registry.getSourceProviders());
    } catch (err) {
      this.#status = 'error';
      this.emit('error', {
        queueItemId: queueItem.queueItemId,
        trackId: queueItem.track.id,
        reason: err instanceof TrackResolutionError ? 'resolution failed' : (err instanceof Error ? err.message : String(err)),
        failedSources: err instanceof TrackResolutionError ? err.failedSources : [],
      });
      this.emit('stateChanged');
      return;
    }

    const engine = this.#registry.getPlaybackEngineFor(resolved);
    if (!engine) {
      this.#status = 'error';
      this.emit('error', {
        queueItemId: queueItem.queueItemId,
        trackId: queueItem.track.id,
        reason: 'no playback engine registered for resolved source',
        failedSources: [],
      });
      this.emit('stateChanged');
      return;
    }

    this.#bindEngine(engine);
    await engine.load(resolved);
    await engine.play();
    this.#status = 'playing';
    this.emit('trackChanged', queueItem);
    this.emit('stateChanged');
  }

  /** @param {import('./types.js').PlaybackEngine} engine @returns {void} */
  #bindEngine(engine) {
    if (this.#activeEngine === engine) return;
    this.#activeEngine = engine;

    const POSITION_THROTTLE_MS = 250;
    let lastEmit = 0;
    engine.on('progress', ({ position, duration }) => {
      this.#position = position;
      this.#duration = duration;
      const now = Date.now();
      if (now - lastEmit >= POSITION_THROTTLE_MS) {
        lastEmit = now;
        this.emit('positionChanged', { position, duration });
      }
    });

    engine.on('ended', () => {
      const moved = this.queue.moveNext();
      if (moved) {
        this.#loadAndPlayCurrent();
      } else {
        this.#status = 'idle';
        this.emit('stateChanged');
      }
    });

    engine.on('error', (error) => {
      this.#status = 'error';
      const queueItem = this.queue.getCurrentItem();
      this.emit('error', {
        queueItemId: queueItem?.queueItemId,
        trackId: queueItem?.track.id,
        reason: error instanceof Error ? error.message : String(error),
        failedSources: [],
      });
      this.emit('stateChanged');
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all CorePlayer tests pass, plus prior tasks' tests.

- [ ] **Step 5: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/CorePlayer.js test/CorePlayer.test.js
git commit -m "feat: implement CorePlayer playback orchestration (play/pause/stop/next/prev/seek)"
```

---

## Task 8: Public package entry point & full verification

**Files:**
- Modify: `src/index.js`
- Create: `test/index.test.js`

**Interfaces:**
- Consumes: `CorePlayer` from `src/CorePlayer.js` (Task 7), `TrackResolutionError` from `src/Resolver.js` (Task 4).
- Produces: the package's public surface — everything a host application imports from `@unitrack/core` (i.e. `import { CorePlayer, TrackResolutionError } from '@unitrack/core'`). This is the last task in the plan.

- [ ] **Step 1: Write the failing smoke test against the public entry point**

`test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorePlayer, TrackResolutionError } from '../src/index.js';
import { createMockSourceProvider, createMockPlaybackEngine } from './helpers/mockPlugins.js';
import { makeTrack } from './helpers/fixtures.js';

test('the public entry point exports a working CorePlayer', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(makeTrack('t1', [{ pluginId: 'local-fs', sourceId: 'l1', kind: 'local' }]));

  await core.play();

  assert.equal(core.getState().status, 'playing');
});

test('the public entry point exports TrackResolutionError', () => {
  const err = new TrackResolutionError('t1', []);
  assert.ok(err instanceof Error);
  assert.equal(err.trackId, 't1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/index.js` does not export `CorePlayer` or `TrackResolutionError`.

- [ ] **Step 3: Wire the public entry point**

Replace the contents of `src/index.js`:

```js
export { CorePlayer } from './CorePlayer.js';
export { TrackResolutionError } from './Resolver.js';
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — every test across all tasks passes.

- [ ] **Step 5: Run the full typecheck**

Run: `npm run typecheck`
Expected: no errors across the whole `src/` tree.

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: expose CorePlayer and TrackResolutionError from the package entry point"
```
