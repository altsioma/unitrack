# CorePlayer Hardening — Design Spec

Date: 2026-08-15

## Purpose

Three correctness gaps in `@unitrack/core`, found by reading `CorePlayer.js`
and `EventEmitter.js` against the guarantees the codebase already claims for
itself elsewhere. Two of the three are explicitly named — and explicitly
deferred — in
`docs/superpowers/plans/2026-08-14-core-player-implementation.md`'s final
review and in the Non-goals section of
`docs/superpowers/specs/2026-08-15-core-player-concurrency-reconciliation-design.md`
("final review issue #3"). This spec is that deferred follow-up.

1. **`restoreState()` bypasses the concurrency guard.** It runs synchronously,
   outside `#operationChain`, and never stops the active playback engine. A
   host calling it while a `play()`/`next()`/`prev()` is still in flight gets
   silently corrupted state: `getState()` can end up reporting `'idle'` while
   audio keeps playing from the pre-restore track.
2. **A throwing `canPlay()` leaves `CorePlayer` stuck at `'loading'` forever.**
   `#loadAndPlayCurrent()` calls `this.#registry.getPlaybackEngineFor(resolved)`
   outside any `try`/`catch`, unlike every other plugin call in the same
   method. `getPlaybackEngineFor` calls each registered engine's synchronous
   `canPlay()`; a throw there propagates as a rejected promise out of the
   public `play()`/`next()`/`prev()`/`seek()` call, and `#emitError()` is
   never reached — so `status` never leaves `'loading'`, no `'error'` event
   fires, and the host has no way to recover except by restarting the app.
3. **`EventEmitter.emit()` isn't isolated.** A throwing handler stops every
   handler registered after it for that event, on that call. Two independent
   listeners on `'stateChanged'` (say, a UI update and a `localStorage`
   persistence hook) are only independent until the first one has a bug —
   then the second silently stops running too, indistinguishable from having
   never been registered.

## Scope

**In scope:**
- Route `restoreState()` through `#operationChain`, stop the active engine
  first, and prevent the queue-rebuild's intermediate `'changed'` events from
  triggering spurious reconciliation.
- Wrap playback-engine selection in `#loadAndPlayCurrent()` in `try`/`catch`,
  routing a thrown `canPlay()` to the existing `#emitError()` path.
- Isolate `EventEmitter` handlers from each other, without silently dropping
  the failure.

**Explicitly out of scope** (separate future work, not addressed here):
- `PluginRegistry.getPlaybackEngineFor()`'s `.find()` semantics — a thrown
  `canPlay()` is treated as "this engine declines," matching what a `false`
  return already means. Whether a throw should instead be collected
  per-engine (mirroring `Resolver.js`'s `failedSources` list for Source
  Providers) is a bigger change to the registry's contract, not this pass.
- Adding `off()`/a disposer to the `PlaybackEngine` plugin contract, or a
  `dispose()` on `CorePlayer` (final review issue #8) — unrelated gap in the
  plugin contract itself.
- `restoreState()`'s event-count and `queueItemId`-churn behavior beyond the
  engine-stop and reconciliation-suppression fixed here (final review issue
  #5's other sub-points).

## 1. `restoreState()` — Serialize and Stop

### Problem, precisely

`restoreState()` today:
```js
restoreState(snapshot) {
  this.queue.clear();
  for (const item of snapshot.queue ?? []) {
    this.queue.add(item.track);
  }
  // ... setCurrentIndex, policy, #loadedQueueItemId = undefined, status = 'idle', ...
}
```
runs immediately, regardless of what `#operationChain` is doing. Two distinct
bugs follow from this:

- **Race with an in-flight operation.** If `play()`/`next()` is mid-`await`
  inside `#loadAndPlayCurrent()` when `restoreState()` runs, the in-flight
  operation finishes *after* `restoreState()` and overwrites its result:
  `#status` gets set back to `'playing'`, `#loadedQueueItemId` gets set to
  the *pre-restore* track's id, and the active engine keeps playing the old
  track — while `getState()` claims the restored queue/position.
- **The active engine is never told to stop.** Even with no race, if
  `restoreState()` is called while something is actually playing, the old
  `PlaybackEngine` instance keeps running. Nothing in the current method
  touches `#activeEngine`.

There's a third, subtler bug: `queue.clear()` and each `queue.add()` call
(one per restored item, since `restoreState` loops rather than calling
`add()` once with an array) each emit `QueueManager`'s `'changed'` event
individually. The constructor's reconciliation listener
(`docs/superpowers/specs/2026-08-15-core-player-concurrency-reconciliation-design.md`)
checks, on every `'changed'`, whether `#loadedQueueItemId` is still present
in the queue — and `restoreState()` doesn't clear `#loadedQueueItemId` until
*after* the rebuild loop finishes. Every intermediate `'changed'` event
during the rebuild sees a stale `#loadedQueueItemId` that (almost always)
isn't in the half-rebuilt queue yet, and enqueues a spurious
`#reconcileMissingCurrentItem()` — a background `#stop()` racing with
`restoreState()`'s own state assignments.

### Fix

`restoreState()` becomes an enqueued operation, following the exact pattern
`play`/`pause`/`stop`/`next`/`prev`/`seek` already use:

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

Two ordering choices matter:

- **`#loadedQueueItemId = undefined` runs first, before any queue
  mutation.** This is what neutralizes the spurious-reconciliation bug: every
  `'changed'` event fired during the rebuild now sees `#loadedQueueItemId ===
  undefined`, and the reconciliation listener's own guard
  (`if (loadedId && ...)`) short-circuits without enqueuing anything.
- **The engine is stopped before the queue is touched**, mirroring `#stop()`
  — so a host inspecting `getState()` never observes a state where the queue
  already reflects the snapshot but stale audio is still audible.

An engine stop failure routes to `#emitError()`, exactly like every other
operation's engine-call failures — `restoreState()` doesn't get a special
error-handling path.

### API impact

`restoreState()`'s return type changes from `void` to `Promise<void>`.
Existing call sites that don't `await` it (as shown in the original core
design spec's persistence example) are unaffected — JS doesn't require
awaiting a returned promise. Call sites that need restoration to be visibly
complete before doing something else (e.g. immediately calling `play()`
right after restoring) should now `await core.restoreState(snapshot)`, the
same way they already await every other Core operation.

## 2. Playback-Engine Selection — Catch and Emit

### Fix

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

This is the same shape as the existing `try { await resolveTrack(...) } catch
{ this.#emitError(...) }` and `try { await engine.load/play() } catch
{ this.#emitError(...) }` blocks immediately above and below it in
`#loadAndPlayCurrent()` — the fix closes a gap in an already-established
pattern rather than introducing a new one. A thrown `canPlay()` now produces
the same host-visible outcome as no engine matching at all: `status:
'error'`, an `'error'` event with a reason, and the operation's promise
resolves (not rejects) — consistent with how a `resolve()` or `load()`
rejection is already handled.

Note this changes *outcome*, not *iteration*: `PluginRegistry.getPlaybackEngineFor`'s
`Array.prototype.find` still stops at the first engine whose `canPlay()`
throws, the same as it stops at the first one returning `true`. Continuing
past a throwing engine to evaluate the rest is the out-of-scope registry
question named above.

## 3. `EventEmitter` — Isolate, Don't Silence

### Fix

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

Every handler runs regardless of whether an earlier one threw — that's the
actual bug fix. The `AggregateError`, thrown once after the full pass, is
what keeps this from becoming another silent-failure path: nothing is lost,
and a caller of `emit()` who cares can catch and inspect `error.errors`.

**Why not swallow, and why not an async rethrow.** A silent catch fully
solves isolation but throws away the failure — this project's own
`electron-demo` spec states its status line exists specifically so "nothing
fails silently." An async rethrow (`queueMicrotask(() => { throw err })`)
preserves visibility without touching `emit()`'s synchronous return, but
makes the failure non-deterministic from a test's point of view — it
surfaces on a later microtask/macrotask, outside the synchronous
`assert.throws`-style check a test would use, and can crash an unrelated
`node --test` run depending on timing. Given this codebase's test-first
posture (`skills/tdd`, a dedicated test file per module), the synchronous
`AggregateError` is the only option that is both non-silent and
deterministically testable.

### Consequence for `CorePlayer`'s own `emit()` calls — accepted, not fixed here

`CorePlayer` calls `this.emit('stateChanged')`, `this.emit('trackChanged',
...)`, etc. as the last step of every state transition, always *after* the
relevant fields (`#status`, `#position`, ...) are already assigned. If a
host's own listener throws, the new `AggregateError` propagates up through
`#play()`/`#pause()`/etc., through `#enqueue`, and out as a rejected promise
from the public `play()`/`pause()`/... call — even though, from Core's own
perspective, the operation already fully completed.

This spec leaves that propagation as-is, deliberately: by the time `emit()`
runs, Core's internal state is already correct (every call site assigns
state before emitting, a pattern already consistent across `#play`,
`#pause`, `#stop`, `#next`, `#prev`, `QueueManager`'s mutators, ...), so a
listener bug can't corrupt Core — it can only make that one call's returned
promise reject. Surfacing it there is arguably useful: it points a host
directly at a bug in code *they* just registered, immediately, rather than
hiding it. Swallowing it inside `CorePlayer` would need a place to put the
failure that isn't itself another `emit()` call (re-emitting `'error'` for a
listener failure on `'error'` itself is circular). If this trade-off proves
wrong in practice — e.g. hosts reporting that a broken analytics listener
makes `play()` look like it failed — revisit with a dedicated `#safeEmit()`
wrapper in `CorePlayer` as its own follow-up.

## Testing

New test cases, matching the existing per-module test files:

`test/CorePlayer.test.js`:
1. **`restoreState()` stops the active engine.** Play a track, then
   `await core.restoreState(otherSnapshot)` — `engine.stop()` was called,
   `status` is `'idle'`, and the engine's internal "loaded source" reflects
   nothing from the pre-restore track.
2. **`restoreState()` is serialized against `play()`.** Call `core.play()`
   without awaiting, then `await core.restoreState(snapshot)` — the restore
   only takes effect after the in-flight `play()` fully resolves; final state
   matches the snapshot, not a hybrid of both.
3. **`restoreState()` does not trigger spurious reconciliation.** Restore a
   snapshot with a current item while some other item was previously loaded
   — `engine.stop()` is called exactly once (from the restore itself), not
   an extra time from the reconciliation listener firing mid-rebuild.
4. **A throwing `canPlay()` surfaces as an `'error'` event, not a stuck
   `'loading'` status.** Register an engine whose `canPlay()` throws; call
   `core.play()` — `status` becomes ``'error'``, an `'error'` event fires
   with the thrown message as `reason`, and `await core.play()` resolves
   (does not reject).

`test/EventEmitter.test.js`:
5. **A throwing handler does not prevent later handlers from running.**
   Register two handlers on the same event, first one throws — assert the
   second one was still called (side-effect flag).
6. **`emit()` throws `AggregateError` after every handler has run**, with
   `errors` containing the original thrown value(s), when one or more
   handlers threw.
7. **`emit()` does not throw when no handler throws** (regression guard for
   the common path).

## Non-goals

Restated from Scope: `PluginRegistry.getPlaybackEngineFor`'s iteration
semantics on a throw, the `PlaybackEngine`/`CorePlayer` disposer gap, and
`restoreState()`'s remaining event-count/`queueItemId`-churn behavior beyond
what's fixed here are all out of scope for this pass.
