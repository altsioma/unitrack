# CorePlayer Concurrency Guard & Queue Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize `CorePlayer`'s `play`/`pause`/`stop`/`next`/`prev`/`seek` through a single operation queue, and make it stop playback when the currently loaded/playing/paused queue item is removed or the queue is cleared out from under it — as specified in `docs/superpowers/specs/2026-08-15-core-player-concurrency-reconciliation-design.md`.

**Architecture:** All playback-affecting public methods on `CorePlayer` become thin wrappers that enqueue their real work (renamed to same-named private methods) onto a single `#operationChain` promise chain, so overlapping calls execute strictly in the order they were issued instead of interleaving. A new `#loadedQueueItemId` field tracks which queue item currently owns the active engine session; the existing `queue.on('changed', ...)` subscription is extended to enqueue a reconciliation check whenever that item disappears from the queue.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs`. Tests via Node's built-in `node:test` + `node:assert/strict`. No new dependencies.

## Global Constraints

- Zero runtime dependencies; no new devDependencies.
- Public API surface of `CorePlayer` does not change: still `play(): Promise<void>`, `pause(): Promise<void>`, `stop(): Promise<void>`, `next(): Promise<void>`, `prev(): Promise<void>`, `seek(seconds: number): Promise<void>`, plus everything else already on the class. None of these six methods may reject/throw — this was already true before this plan and must remain true.
- Only `src/CorePlayer.js` (modified) and `test/CorePlayer.test.js` (appended) are touched. No other file changes.
- Concurrency approach is full serialization (a single operation chain), not a generation/cancellation-token scheme — every enqueued call runs to completion in the order it was issued; none are dropped or abandoned mid-flight.
- Reconciliation triggers only when the currently loaded/playing/paused item's `queueItemId` is no longer present anywhere in `queue.getItems()` (i.e. it was removed, or the queue was cleared) — not merely when the queue's current-pointer moves during ordinary navigation (`next()`/`prev()`/auto-advance on `'ended'`). On trigger, `CorePlayer` stops and returns to `'idle'`; it does not auto-advance to whatever is now current.
- `npm run typecheck` must report zero errors, and `npm test` must pass with pristine output, at the end of every task.

---

## Task 1: Concurrency guard — serialize play/pause/stop/next/prev/seek

**Files:**
- Modify: `src/CorePlayer.js`
- Modify: `test/CorePlayer.test.js` (append)

**Interfaces:**
- Consumes: the current `src/CorePlayer.js` as it exists after the original implementation plan — specifically the existing bodies of `play()`, `pause()`, `stop()`, `next()`, `prev()`, `seek(seconds)` (to be renamed, logic unchanged), the existing `#loadAndPlayCurrent()` and `#bindEngine(engine)` methods (unchanged by this task except for the `'ended'` listener inside `#bindEngine`, which is refactored to call a new extracted method), and `#emitError(queueItem, reason, failedSources)` (unchanged). Consumes `trackWithLocalSource(id, sourceId)`, `makeTrack(id, sources)` from `test/helpers/fixtures.js`, and `createMockSourceProvider`, `createMockPlaybackEngine` from `test/helpers/mockPlugins.js` (all pre-existing, already imported in `test/CorePlayer.test.js`).
- Produces: `#enqueue(operation)` — a private method that serializes async work; `#operationChain` — the tracked chain state; private `#play()`, `#pause()`, `#stop()`, `#next()`, `#prev()`, `#seek(seconds)` — same logic as the pre-existing public methods, now run only via the queue; `#advanceOnEnded()` — the auto-advance logic extracted from the `'ended'` listener, also run via the queue. Task 2 adds fields/logic to `#loadAndPlayCurrent()`, `#stop()`, `#emitError()`, `#advanceOnEnded()`, and the constructor that this task produces — it must find these exact method names and signatures.

- [ ] **Step 1: Write the failing tests**

Append to `test/CorePlayer.test.js` (after the existing last test, `'engine error event during playback stops and emits error'` — or after whatever the current last test in the file is; add these as new `test(...)` blocks at the end of the file):

```js
test('concurrent next() calls resolve in order rather than racing', async () => {
  const core = new CorePlayer();
  // The resolve for t2's source (l2) is deliberately slower than t3's
  // (l3). With trivially-resolving mocks of identical shape, two
  // overlapping next() calls happen to complete in start order even
  // without a concurrency guard, which would make this test pass
  // regardless of whether serialization exists. The delay is keyed to
  // l2's sourceId specifically (not a call counter) so it only affects
  // the race itself, not the earlier play() call that resolves t1/l1
  // during setup.
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async (ref) => {
      if (ref.sourceId === 'l2') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { url: `file:///${ref.sourceId}.flac` };
    },
  });
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  core.registerSourceProvider(provider);
  core.registerPlaybackEngine(engine);
  core.setPolicy([{ kind: 'local' }]);
  core.queue.add([
    trackWithLocalSource('t1', 'l1'),
    trackWithLocalSource('t2', 'l2'),
    trackWithLocalSource('t3', 'l3'),
  ]);
  await core.play();

  const trackChanged = [];
  core.on('trackChanged', (item) => trackChanged.push(item.track.id));

  await Promise.all([core.next(), core.next()]);

  assert.equal(core.getState().currentQueueItem.track.id, 't3');
  assert.deepEqual(engine.loaded, { url: 'file:///l3.flac' });
  assert.deepEqual(trackChanged, ['t2', 't3']);
});

test('pause() issued during an in-flight play() still ends up paused', async () => {
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

  const playPromise = core.play();
  const pausePromise = core.pause();
  await Promise.all([playPromise, pausePromise]);

  assert.equal(core.getState().status, 'paused');
  assert.equal(engine.playCalls, 1);
  assert.equal(engine.pauseCalls, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL. `'concurrent next() calls resolve in order...'` fails deterministically: without serialization, the second `next()` call's resolve (no delay) completes and finishes loading/playing t3 before the first call's resolve (20ms delay) completes and finishes loading/playing t2, so the first call's later completion clobbers the engine's loaded state back to t2 and fires `trackChanged` out of order (`['t3', 't2']`) — `engine.loaded` ends up `{ url: 'file:///l2.flac' }`, not `l3.flac`, and the assertions fail. `'pause() issued during an in-flight play()...'` fails because today's `pause()` no-ops when `status !== 'playing'`, so the final status stays `'playing'`, not `'paused'`.

- [ ] **Step 3: Rename the existing public methods to private, and add the operation queue**

In `src/CorePlayer.js`, add this new private field next to `#boundEngines`:

```js
  /** @type {Promise<void>} */
  #operationChain = Promise.resolve();
```

Replace the existing `play()`, `pause()`, `stop()`, `next()`, `prev()`, `seek(seconds)` methods (the six public playback methods, currently defined directly with their full logic) with the following — six thin public wrappers, an `#enqueue` helper, and six private methods carrying the exact same logic the public methods had before (only the method names change: `play` → `#play`, `pause` → `#pause`, `stop` → `#stop`, `next` → `#next`, `prev` → `#prev`, `seek` → `#seek`):

```js
  /** @returns {Promise<void>} */
  async play() {
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
    if (this.#status === 'playing') return;
    if (this.#status === 'paused' && this.#activeEngine) {
      try {
        await this.#activeEngine.play();
      } catch (err) {
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
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
  async #pause() {
    if (this.#status !== 'playing' || !this.#activeEngine) return;
    try {
      await this.#activeEngine.pause();
    } catch (err) {
      this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
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
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.#status = 'idle';
    this.#position = 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #next() {
    const moved = this.queue.moveNext();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @returns {Promise<void>} */
  async #prev() {
    const moved = this.queue.movePrevious();
    if (!moved) return;
    await this.#loadAndPlayCurrent();
  }

  /** @param {number} seconds @returns {Promise<void>} */
  async #seek(seconds) {
    if (!this.#activeEngine || this.#status === 'idle' || this.#status === 'error') return;
    try {
      await this.#activeEngine.seek(seconds);
    } catch (err) {
      this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
    }
  }
```

Leave `#loadAndPlayCurrent()`, `#bindEngine(engine)` (except the `'ended'` listener — see next step), and `#emitError(...)` exactly as they are for this step.

- [ ] **Step 4: Extract the `'ended'` auto-advance logic so it also goes through the queue**

Inside `#bindEngine`, find the existing `'ended'` listener:

```js
    engine.on('ended', () => {
      const moved = this.queue.moveNext();
      if (moved) {
        this.#loadAndPlayCurrent().catch((err) => {
          this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
        });
      } else {
        this.#status = 'idle';
        this.emit('stateChanged');
      }
    });
```

Replace it with:

```js
    engine.on('ended', () => {
      this.#enqueue(() => this.#advanceOnEnded()).catch((err) => {
        this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
      });
    });
```

Add this new private method to the class body (near `#loadAndPlayCurrent`):

```js
  /** @returns {Promise<void>} */
  async #advanceOnEnded() {
    const moved = this.queue.moveNext();
    if (moved) {
      await this.#loadAndPlayCurrent();
    } else {
      this.#status = 'idle';
      this.emit('stateChanged');
    }
  }
```

(Task 2 will modify this method's `else` branch further — leave it exactly as above for this task.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — both new tests pass, and all pre-existing tests (64 from the original plan) still pass. Run the suite 2-3 times in a row to confirm the concurrency test isn't flaky.

- [ ] **Step 6: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/CorePlayer.js test/CorePlayer.test.js
git commit -m "feat: serialize CorePlayer playback operations through a single queue"
```

---

## Task 2: Queue reconciliation — stop playback when the loaded item disappears

**Files:**
- Modify: `src/CorePlayer.js`
- Modify: `test/CorePlayer.test.js` (append)

**Interfaces:**
- Consumes: `#enqueue(operation)` and the private `#play()`/`#pause()`/`#stop()`/`#next()`/`#prev()`/`#seek()`/`#advanceOnEnded()` methods from Task 1. Consumes the existing `#loadAndPlayCurrent()`, `#emitError(queueItem, reason, failedSources)`, and the constructor's `queue.on('changed', ...)` subscription (currently only re-emitting `queueChanged`).
- Produces: a new `#loadedQueueItemId` field (the invariant: truthy only while `#status` is `'loading'`, `'playing'`, or `'paused'` — cleared on every transition to `'idle'` or `'error'`); `#reconcileMissingCurrentItem(missingQueueItemId)`. No public API changes.

- [ ] **Step 1: Write the failing tests**

Append to `test/CorePlayer.test.js`:

```js
test('removing the currently-playing item stops playback and returns to idle', async () => {
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

  const current = core.getState().currentQueueItem;
  core.queue.remove(current.queueItemId);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('clearing the queue during playback stops playback and returns to idle', async () => {
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

  core.queue.clear();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'idle');
  assert.equal(engine.stopCalls, 1);
});

test('reordering the queue during playback does not interrupt it', async () => {
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

  const current = core.getState().currentQueueItem;
  core.queue.reorder(current.queueItemId, 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(core.getState().status, 'playing');
  assert.equal(engine.stopCalls, 0);
});

test('normal next() navigation is unaffected by reconciliation', async () => {
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

  assert.equal(core.getState().status, 'playing');
  assert.equal(core.getState().currentQueueItem.track.id, 't2');
  assert.equal(engine.stopCalls, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the four new tests FAIL. The first two fail because nothing today reacts to `queue.remove()`/`queue.clear()` — status stays `'playing'` and `engine.stopCalls` stays `0`. The other two should already pass even before this task's implementation (they assert the *absence* of a reaction) — that's expected; they exist to guard against a future regression, and TDD's RED step for them is trivially satisfied (no code changes needed for them to pass, but running them now provides a baseline).

- [ ] **Step 3: Add the `#loadedQueueItemId` field**

In `src/CorePlayer.js`, add this field next to `#operationChain`:

```js
  /** @type {string | undefined} */
  #loadedQueueItemId;
```

- [ ] **Step 4: Set it in `#loadAndPlayCurrent`**

Find:

```js
  async #loadAndPlayCurrent() {
    const queueItem = this.queue.getCurrentItem();
    if (!queueItem) return;

    this.#status = 'loading';
```

Change to:

```js
  async #loadAndPlayCurrent() {
    const queueItem = this.queue.getCurrentItem();
    if (!queueItem) return;
    this.#loadedQueueItemId = queueItem.queueItemId;

    this.#status = 'loading';
```

- [ ] **Step 5: Clear it in `#stop`, `#emitError`, and `#advanceOnEnded`'s idle branch**

In `#stop()`, find:

```js
    this.#status = 'idle';
    this.#position = 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #next() {
```

Change to:

```js
    this.#loadedQueueItemId = undefined;
    this.#status = 'idle';
    this.#position = 0;
    this.emit('stateChanged');
  }

  /** @returns {Promise<void>} */
  async #next() {
```

In `#emitError`, find:

```js
  #emitError(queueItem, reason, failedSources = []) {
    this.#status = 'error';
```

Change to:

```js
  #emitError(queueItem, reason, failedSources = []) {
    this.#loadedQueueItemId = undefined;
    this.#status = 'error';
```

In `#advanceOnEnded` (added in Task 1), find:

```js
  async #advanceOnEnded() {
    const moved = this.queue.moveNext();
    if (moved) {
      await this.#loadAndPlayCurrent();
    } else {
      this.#status = 'idle';
      this.emit('stateChanged');
    }
  }
```

Change to:

```js
  async #advanceOnEnded() {
    const moved = this.queue.moveNext();
    if (moved) {
      await this.#loadAndPlayCurrent();
    } else {
      this.#loadedQueueItemId = undefined;
      this.#status = 'idle';
      this.emit('stateChanged');
    }
  }
```

This keeps the invariant intact everywhere `#status` transitions to `'idle'` or `'error'`: `#loadedQueueItemId` is `undefined` whenever nothing is actively loading, playing, or paused.

- [ ] **Step 6: Add the reconciliation check to the constructor, and the reconciliation method**

Find the constructor:

```js
  constructor() {
    super();
    this.queue.on('changed', () => this.emit('queueChanged'));
  }
```

Change to:

```js
  constructor() {
    super();
    this.queue.on('changed', () => {
      this.emit('queueChanged');
      const loadedId = this.#loadedQueueItemId;
      if (loadedId && !this.queue.getItems().some((i) => i.queueItemId === loadedId)) {
        this.#enqueue(() => this.#reconcileMissingCurrentItem(loadedId));
      }
    });
  }
```

Add this new private method to the class body (near `#advanceOnEnded`):

```js
  /**
   * @param {string} missingQueueItemId
   * @returns {Promise<void>}
   */
  async #reconcileMissingCurrentItem(missingQueueItemId) {
    if (this.#loadedQueueItemId !== missingQueueItemId) return;
    if (this.queue.getItems().some((i) => i.queueItemId === missingQueueItemId)) return;
    await this.#stop();
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all four new tests pass, and every test from Task 1 and the original 8-task plan (68 tests total before this task's four additions) still passes. Run the suite 2-3 times to confirm no flakiness.

- [ ] **Step 8: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/CorePlayer.js test/CorePlayer.test.js
git commit -m "feat: stop playback when the loaded queue item is removed or the queue is cleared"
```
