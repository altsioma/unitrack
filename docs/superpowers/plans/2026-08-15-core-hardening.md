# CorePlayer Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three correctness gaps in `@unitrack/core` — `EventEmitter.emit()` letting one throwing handler silence the rest, a throwing `canPlay()` leaving `CorePlayer` stuck at `'loading'` forever, and `restoreState()` bypassing the concurrency guard and never stopping the active engine — as specified in `docs/superpowers/specs/2026-08-15-core-hardening-design.md`.

**Architecture:** Three independent fixes, landed as three separate tasks/commits, ordered simplest-and-most-isolated first: `EventEmitter.emit()` isolates each handler in its own `try`/`catch` and reports failures via a single `AggregateError` thrown after every handler has run; `#loadAndPlayCurrent()` wraps playback-engine selection in `try`/`catch`, routing to the existing `#emitError()`; `restoreState()` becomes an enqueued operation (like `play`/`pause`/`stop`/`next`/`prev`/`seek`) that stops the active engine and clears `#loadedQueueItemId` before rebuilding the queue.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs --strict`. Tests via Node's built-in `node:test` + `node:assert/strict`. No new dependencies.

## Global Constraints

- Zero runtime dependencies; no new devDependencies.
- Only `src/CorePlayer.js`, `src/EventEmitter.js`, `test/CorePlayer.test.js`, and `test/EventEmitter.test.js` are touched. No other file changes.
- `restoreState()`'s return type changes from `void` to `Promise<void>` — this is a deliberate, documented API change (see spec, "API impact"). Existing call sites that don't `await` it are unaffected; the two existing tests that read state synchronously right after calling it (Task 3, Step 1) must be updated to `await` it, or they'll observe pre-restore state, since `#enqueue` always schedules its operation on a microtask even against an already-resolved chain.
- `EventEmitter.emit()`'s new failure mode (`AggregateError` after all handlers run) is a deliberate scope boundary: `CorePlayer`'s own internal `this.emit(...)` calls are left as-is, not wrapped defensively — see spec, "Consequence for CorePlayer's own emit() calls." Do not add a `#safeEmit()` wrapper in `CorePlayer` as part of this plan.
- `npm run typecheck` must report zero errors, and `npm test` must pass with pristine output, at the end of every task.

---

## Task 1: EventEmitter — isolate handlers, report via AggregateError

**Files:**
- Modify: `src/EventEmitter.js`
- Modify: `test/EventEmitter.test.js` (append)

**Interfaces:**
- Consumes: nothing new — `EventEmitter`'s existing `#listeners` field and `on`/`off` methods are unchanged.
- Produces: `emit(event, payload)`'s behavior changes (return type stays `void`, but it can now throw `AggregateError`). No new public methods.

- [ ] **Step 1: Write the failing tests**

Append to `test/EventEmitter.test.js` (after the existing last test, `'events are isolated from each other'`):

```js
test('a throwing handler does not prevent later handlers for the same event from running', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('foo', () => { throw new Error('first handler is broken'); });
  emitter.on('foo', () => calls.push('second ran'));
  assert.throws(() => emitter.emit('foo'));
  assert.deepEqual(calls, ['second ran']);
});

test('emit throws an AggregateError containing every handler that threw, after all handlers have run', () => {
  const emitter = new EventEmitter();
  const errA = new Error('a broke');
  const errB = new Error('b broke');
  const calls = [];
  emitter.on('foo', () => { calls.push('a'); throw errA; });
  emitter.on('foo', () => { calls.push('b'); throw errB; });
  emitter.on('foo', () => calls.push('c'));

  assert.throws(() => emitter.emit('foo'), (err) => {
    assert.ok(err instanceof AggregateError);
    assert.deepEqual(err.errors, [errA, errB]);
    return true;
  });
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('emit does not throw when no handler throws', () => {
  const emitter = new EventEmitter();
  emitter.on('foo', () => {});
  emitter.on('foo', () => {});
  assert.doesNotThrow(() => emitter.emit('foo'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @unitrack/core`
Expected: the first two new tests FAIL. `'a throwing handler does not prevent later handlers...'` fails because today's `emit()` stops iterating at the first throw — `calls` ends up `[]`, not `['second ran']`, and the throw happens but `assert.throws` alone would actually pass; it's the `deepEqual` on `calls` that fails. `'emit throws an AggregateError...'` fails because today's `emit()` throws `errA` directly (not wrapped in `AggregateError`), so `err instanceof AggregateError` is false, and `calls` is `['a']`, not `['a', 'b', 'c']` (iteration stopped after the first throw). `'emit does not throw when no handler throws'` already passes.

- [ ] **Step 3: Isolate handlers and collect errors**

Replace `emit()` in `src/EventEmitter.js`:

```js
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
```

with:

```js
  /**
   * @param {string} event
   * @param {*} [payload]
   * @returns {void}
   */
  emit(event, payload) {
    const handlers = this.#listeners.get(event);
    if (!handlers) return;
    /** @type {unknown[]} */
    const errors = [];
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} listener(s) for '${event}' threw`);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @unitrack/core`
Expected: PASS — all three new tests pass, and every pre-existing test in `test/EventEmitter.test.js` still passes (the existing `'emit with no listeners for the event does not throw'` test still holds: `handlers` is `undefined`, the function returns before the loop).

- [ ] **Step 5: Run the typecheck**

Run: `npm run typecheck -w @unitrack/core`
Expected: no errors. `AggregateError` is a standard global (ES2021+); confirm `packages/core/tsconfig.json`'s `"target"` is at least `ES2021` — it is already `ES2022`.

- [ ] **Step 6: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both pass across every workspace package.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/EventEmitter.js packages/core/test/EventEmitter.test.js
git commit -m "fix: isolate EventEmitter handlers so one throwing listener can't silence the rest"
```

---

## Task 2: Catch playback-engine selection errors

**Files:**
- Modify: `src/CorePlayer.js`
- Modify: `test/CorePlayer.test.js` (append)

**Interfaces:**
- Consumes: the existing `#registry.getPlaybackEngineFor(resolved)`, `#emitError(queueItem, reason, failedSources)`, and `#loadAndPlayCurrent()` — all unchanged in shape.
- Produces: no new public API. `#loadAndPlayCurrent()`'s internal error handling gains one more `try`/`catch`.

- [ ] **Step 1: Write the failing test**

Append to `test/CorePlayer.test.js` (after `'play emits an error when no registered engine can play the resolved source'`):

```js
test('a throwing canPlay() surfaces as an error event instead of leaving status stuck at loading', async () => {
  const core = new CorePlayer();
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => ({ url: 'file:///a.flac' }),
  });
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    canPlayImpl: () => { throw new Error('codec probe failed'); },
  });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  const errors = [];
  core.on('error', (payload) => errors.push(payload));

  await assert.doesNotReject(() => core.play());

  assert.equal(core.getState().status, 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].trackId, 't1');
  assert.equal(errors[0].reason, 'codec probe failed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @unitrack/core`
Expected: FAIL. Today, `getPlaybackEngineFor`'s `canPlay()` throw propagates out of `#loadAndPlayCurrent()` uncaught, up through `#play()` and `#enqueue`, so the public `play()` promise *rejects* — `assert.doesNotReject(() => core.play())` fails with the thrown `Error('codec probe failed')`, and `core.getState().status` is left at `'loading'`, not `'error'`.

- [ ] **Step 3: Wrap playback-engine selection in try/catch**

In `src/CorePlayer.js`, find (inside `#loadAndPlayCurrent()`):

```js
    const engine = this.#registry.getPlaybackEngineFor(resolved);
    if (!engine) {
      this.#emitError(queueItem, 'no playback engine registered for resolved source');
      return;
    }
```

Change to:

```js
    /** @type {import('./types.js').PlaybackEngine | undefined} */
    let engine;
    try {
      engine = this.#registry.getPlaybackEngineFor(resolved);
    } catch (err) {
      this.#emitError(queueItem, err instanceof Error ? err.message : String(err));
      return;
    }
    if (!engine) {
      this.#emitError(queueItem, 'no playback engine registered for resolved source');
      return;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @unitrack/core`
Expected: PASS — the new test passes, and every pre-existing test still passes (in particular, `'play emits an error when no registered engine can play the resolved source'`, which exercises the `!engine` branch immediately below the new `try`/`catch` and must be untouched by it).

- [ ] **Step 5: Run the typecheck**

Run: `npm run typecheck -w @unitrack/core`
Expected: no errors.

- [ ] **Step 6: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/CorePlayer.js packages/core/test/CorePlayer.test.js
git commit -m "fix: catch a throwing canPlay() instead of leaving CorePlayer stuck at 'loading'"
```

---

## Task 3: Serialize restoreState() and stop the active engine

**Files:**
- Modify: `src/CorePlayer.js`
- Modify: `test/CorePlayer.test.js` (modify two existing tests, append new ones)

**Interfaces:**
- Consumes: `#enqueue(operation)` (from the existing concurrency guard), `#activeEngine`, `#emitError(queueItem, reason, failedSources)`, `queue.clear()`/`queue.add()`/`queue.setCurrentIndex()` — all unchanged in shape.
- Produces: `restoreState(snapshot)`'s return type changes from `void` to `Promise<void>`. A new private `#restoreState(snapshot)` carries the actual logic. No other public API changes.

- [ ] **Step 1: Update the two existing synchronous restoreState tests to await it**

In `test/CorePlayer.test.js`, find:

```js
test('restoreState rebuilds the queue in order and preserves the current item', () => {
  const core = new CorePlayer();
  core.queue.add([makeTrack('t1'), makeTrack('t2')]);
  core.queue.setCurrentIndex(1);
  const snapshot = core.getState();

  const restored = new CorePlayer();
  restored.restoreState(snapshot);
  const restoredState = restored.getState();
```

Change to:

```js
test('restoreState rebuilds the queue in order and preserves the current item', async () => {
  const core = new CorePlayer();
  core.queue.add([makeTrack('t1'), makeTrack('t2')]);
  core.queue.setCurrentIndex(1);
  const snapshot = core.getState();

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  const restoredState = restored.getState();
```

Find:

```js
test('restoreState with no current item leaves the queue unselected', () => {
  const core = new CorePlayer();
  core.queue.add(makeTrack('t1'));
  const snapshot = core.getState();

  const restored = new CorePlayer();
  restored.restoreState(snapshot);
  assert.equal(restored.getState().currentQueueItem, undefined);
});
```

Change to:

```js
test('restoreState with no current item leaves the queue unselected', async () => {
  const core = new CorePlayer();
  core.queue.add(makeTrack('t1'));
  const snapshot = core.getState();

  const restored = new CorePlayer();
  await restored.restoreState(snapshot);
  assert.equal(restored.getState().currentQueueItem, undefined);
});
```

This is required, not optional cleanup: once `restoreState()` is enqueued (Step 4 below), it always schedules its work as a microtask via `#operationChain.then(...)` — even against an already-resolved chain, `.then()` callbacks never run synchronously. Without `await`, both tests would read `getState()` before the restore has actually happened.

Also update the existing `'restoreState on an already-active instance...'` test's assertion — find:

```js
  core.restoreState({
    status: 'idle',
    currentQueueItem: undefined,
    position: 42,
    duration: 0,
    queue: [],
    policy: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().position, 42);
  assert.equal(engine.stopCalls, 0);
});
```

Change to:

```js
  core.restoreState({
    status: 'idle',
    currentQueueItem: undefined,
    position: 42,
    duration: 0,
    queue: [],
    policy: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Before this task, restoreState() never stopped the active engine at
  // all (the bug this task fixes) — 0 was the old, wrong expectation.
  // Now restoreState() stops it exactly once, itself; this asserts that
  // reconciliation doesn't *also* fire a second, spurious stop on top of
  // that intentional one.
  assert.equal(core.getState().position, 42);
  assert.equal(engine.stopCalls, 1);
});
```

- [ ] **Step 2: Write the new failing tests**

Append to `test/CorePlayer.test.js`:

```js
test('restoreState() stops the active engine', async () => {
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

  await core.restoreState({
    status: 'idle', currentQueueItem: undefined, position: 0, duration: 0, queue: [], policy: [],
  });

  assert.equal(engine.stopCalls, 1);
  assert.equal(core.getState().status, 'idle');
});

test('restoreState() is serialized against an in-flight play()', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { url: 'file:///a.flac' };
    },
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  const core = new CorePlayer();
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add(trackWithLocalSource('t1'));

  const playPromise = core.play();
  const snapshot = { status: 'idle', currentQueueItem: undefined, position: 7, duration: 0, queue: [], policy: [] };
  const restorePromise = core.restoreState(snapshot);
  await Promise.all([playPromise, restorePromise]);

  // restoreState() only runs after play() has fully finished loading and
  // playing t1 — so it stops the now-active engine and ends up idle with
  // the restored (empty) queue and position, not a hybrid of both calls.
  assert.equal(core.getState().status, 'idle');
  assert.equal(core.getState().position, 7);
  assert.equal(core.getState().queue.length, 0);
  assert.equal(engine.stopCalls, 1);
});

test('restoreState() does not trigger a spurious reconciliation stop during the rebuild', async () => {
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

  // Restoring a snapshot with several items exercises multiple
  // intermediate queue.add() calls (and their 'changed' events) during
  // the rebuild, while the pre-restore #loadedQueueItemId is still (very
  // briefly, before this fix) capable of going stale mid-loop.
  await core.restoreState({
    status: 'idle',
    currentQueueItem: undefined,
    position: 0,
    duration: 0,
    queue: [makeTrack('r1'), makeTrack('r2'), makeTrack('r3')],
    policy: [],
  });

  assert.equal(engine.stopCalls, 1);
  assert.equal(core.getState().queue.length, 3);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @unitrack/core`
Expected: several tests FAIL — the two modified pre-existing tests fail at `restored.restoreState(snapshot)` / `restored.getState()` type-mismatch is not the issue (JS won't error on ignoring a promise), but rather because `getState()` is read before the now-enqueued restore has run, so it still reflects the fresh `CorePlayer`'s default empty state, not the snapshot. The updated `'restoreState on an already-active instance...'` assertion (`stopCalls, 1`) fails because today's `restoreState()` never stops the engine at all (`stopCalls` stays `0`). All three new tests fail similarly: `'restoreState() stops the active engine'` and `'...does not trigger a spurious reconciliation stop...'` see `engine.stopCalls === 0`; `'restoreState() is serialized against an in-flight play()'` sees the restore apply immediately (queue is `[]`/position `7` right away, since today's `restoreState()` isn't enqueued) rather than after `play()` finishes, so the final assertions on `status`/`queue.length` mismatch what actually happens (play's own state overwrites the early restore).

- [ ] **Step 4: Serialize restoreState() and stop the engine first**

In `src/CorePlayer.js`, find the existing public method:

```js
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
    this.#loadedQueueItemId = undefined;
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
  }
```

Change to:

```js
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
    this.#policy = snapshot.policy ?? [];
    this.#status = 'idle';
    this.#position = snapshot.position ?? 0;
    this.#duration = snapshot.duration ?? 0;
    this.emit('stateChanged');
  }
```

Two things to get right, both already reasoned through in the spec:
- `#loadedQueueItemId = undefined` is the *first* line of `#restoreState`, before any queue mutation — this is what stops the queue rebuild's intermediate `'changed'` events from triggering a spurious reconciliation (the constructor's `queue.on('changed', ...)` guard is `if (loadedId && ...)`, so once `loadedId` is `undefined` it short-circuits).
- The engine is stopped, and `#activeEngine` cleared, *before* the queue is touched — matching `#stop()`'s own ordering.

The final `this.emit('stateChanged')` is new — the old synchronous `restoreState()` never emitted anything after restoring, which was consistent with it running synchronously (a host calling it already knows when it's done). Now that it's async/enqueued like every other operation, it should notify listeners on completion the same way `#play()`/`#pause()`/`#stop()` etc. already do.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @unitrack/core`
Expected: PASS — all tests from Step 1 and Step 2 pass, and every other pre-existing test in the file still passes. Run the suite 2-3 times to confirm `'restoreState() is serialized against an in-flight play()'` isn't flaky (it has a timing-sensitive `setTimeout` inside its mock `resolveImpl`, same pattern as the existing concurrent-`next()` test).

- [ ] **Step 6: Run the typecheck**

Run: `npm run typecheck -w @unitrack/core`
Expected: no errors.

- [ ] **Step 7: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both pass — 73 pre-existing core tests plus 3 (Task 1) + 1 (Task 2) + 3 (Task 3) = 80 in core; 19 in engine-web-audio; 6 in source-local-fs, all unaffected.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/CorePlayer.js packages/core/test/CorePlayer.test.js
git commit -m "fix: serialize restoreState() and stop the active engine before rebuilding the queue"
```
