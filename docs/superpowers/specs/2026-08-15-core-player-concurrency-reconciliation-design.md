# CorePlayer Concurrency Guard & Queue Reconciliation — Design Spec

Date: 2026-08-15

## Purpose

Follow-up hardening for `@unitrack/core`'s `CorePlayer`, addressing two related
gaps found by the final whole-branch review of the initial implementation
(`docs/superpowers/plans/2026-08-14-core-player-implementation.md`), and
explicitly deferred there as follow-up work rather than merge blockers:

1. **No concurrency guard.** Overlapping calls to `play()`/`pause()`/`stop()`/
   `next()`/`prev()`/`seek()` (e.g. a double-clicked "next" button, or
   `pause()` called while a `play()` is still resolving) can interleave and
   desynchronize the active playback engine from the queue pointer —
   `getState()` can report a different track than what the engine is
   actually playing.
2. **No reaction to queue mutations during playback.** `CorePlayer` never
   observes `QueueManager` mutations beyond re-emitting `queueChanged`. If a
   host directly calls `queue.remove()` or `queue.clear()` on the
   currently-playing (or currently-loading) item, the engine keeps running
   while `CorePlayer`'s own state no longer reflects it.

A third issue from the same review — `pause()` called while `status ===
'loading'` being silently dropped — is fixed as a side effect of the
concurrency guard's design (see below), without separate code.

## Scope

**In scope:**
- A serialized operation queue for `play`/`pause`/`stop`/`next`/`prev`/
  `seek`, and for the internal auto-advance triggered by a playback
  engine's `'ended'` event.
- Reconciliation: when the queue item a currently loading/playing/paused
  session belongs to disappears from the queue (removed, or the queue is
  cleared), `CorePlayer` stops playback and returns to `'idle'`.

**Explicitly out of scope** (separate follow-ups, not addressed here):
- Broader synchronous-exception hardening in `EventEmitter`, or around
  synchronous plugin calls like `canPlay()`/`on()` (final review issue #3).
- `restoreState()`'s event-count, `queueItemId`-churn, and no-engine-stop
  issues (final review issue #5).
- Adding `off()`/a disposer to the `PlaybackEngine` plugin contract, or a
  `dispose()` on `CorePlayer` (final review issue #8) — this is a gap in
  the design spec's plugin contract, not something to patch unilaterally
  here.
- Reacting to a host calling `queue.setCurrentIndex()` directly to jump the
  pointer elsewhere without going through `next()`/`prev()`. This is a
  distinct "manual pointer jump" scenario, not "the current item was
  removed" — the item a session is playing still exists in the queue in
  this case, so reconciliation as designed here does not (and should not)
  fire for it.

## Concurrency Guard

**Approach: full serialization**, not a "last call wins" generation token.
Every call to `play`/`pause`/`stop`/`next`/`prev`/`seek` — and the internal
work triggered by a playback engine's `'ended'` event — is queued onto a
single operation chain and executed strictly in order. A `next()` issued
while a previous `next()` is still resolving simply waits its turn; neither
call is dropped or its effect discarded, and both fully complete in the
order they were issued.

This was chosen over an alternative "generation token" design (each
`#loadAndPlayCurrent()` invocation stamps a token at start and checks it
after every `await`, abandoning stale work) because:
- Serialization processes every caller's intent in order, rather than
  silently discarding the effect of superseded calls.
- It requires no cleanup logic for "a stale operation's `engine.load()`/
  `engine.play()` already fired in the background" — under serialization,
  an operation only starts once every prior one has fully finished, so
  there is never more than one in-flight load/play sequence.
- It naturally fixes the `pause()`-during-`'loading'` bug (see below)
  without separate handling.

### Mechanism

```js
/** @type {Promise<void>} */
#operationChain = Promise.resolve();

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
```

`operation` runs whether the prior link in the chain resolved or rejected
(`.then(operation, operation)`), so one operation's failure can never block
subsequent ones. The tracked chain-state promise (`#operationChain`) is
normalized to always resolve (`.then(() => undefined, () => undefined)`) so
the next `#enqueue` call always has a settled promise to chain onto. The
caller receives `result` — the actual operation's own promise — so
`await core.play()` still reflects when that specific call's work is done,
not just when it was scheduled.

The existing bodies of `play()`, `pause()`, `stop()`, `next()`, `prev()`,
and `seek()` are renamed to private methods (`#play()`, `#pause()`,
`#stop()`, `#next()`, `#prev()`, `#seek()`) with identical logic. The
public methods become:

```js
async play() { return this.#enqueue(() => this.#play()); }
async pause() { return this.#enqueue(() => this.#pause()); }
async stop() { return this.#enqueue(() => this.#stop()); }
async next() { return this.#enqueue(() => this.#next()); }
async prev() { return this.#enqueue(() => this.#prev()); }
async seek(seconds) { return this.#enqueue(() => this.#seek(seconds)); }
```

The `'ended'` handler inside `#bindEngine` is also updated to enqueue its
auto-advance work instead of calling `#loadAndPlayCurrent()` directly:

```js
engine.on('ended', () => {
  this.#enqueue(() => this.#advanceOnEnded()).catch((err) => {
    this.#emitError(this.queue.getCurrentItem(), err instanceof Error ? err.message : String(err));
  });
});
```

where `#advanceOnEnded()` contains the existing "move next, load and play,
or go idle if nothing follows" logic currently inlined in the handler.

### Side effect: fixes `pause()` during `'loading'`

Because every operation is serialized, calling `pause()` while a `play()`/
`next()`/`prev()` is still loading means `#pause()` only runs *after* the
in-flight load finishes (successfully or not). By then `#status` has
already settled to `'playing'` (or `'error'`), so `#pause()`'s existing
guard (`if (this.#status !== 'playing' || !this.#activeEngine) return;`)
behaves correctly — pausing what just started, or correctly no-op'ing if
the load failed. No special-case code is needed for this; it falls out of
the serialization design.

## Queue Reconciliation

A new private field tracks which queue item's `queueItemId` currently owns
an active engine session:

```js
/** @type {string | undefined} */
#loadedQueueItemId;
```

- Set at the very top of `#loadAndPlayCurrent()`, before `resolveTrack` is
  called.
- Cleared inside `#stop()`, alongside the existing transition to `'idle'`.

The constructor's existing subscription to `queue.on('changed', ...)` (used
today only to re-emit `queueChanged`) gains a check: if the currently
loaded/playing/paused item's `queueItemId` is no longer present anywhere in
`queue.getItems()`, a reconciliation operation is enqueued through the same
operation chain used by the concurrency guard:

```js
this.queue.on('changed', () => {
  this.emit('queueChanged');
  const loadedId = this.#loadedQueueItemId;
  if (loadedId && !this.queue.getItems().some((i) => i.queueItemId === loadedId)) {
    this.#enqueue(() => this.#reconcileMissingCurrentItem(loadedId));
  }
});

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

### Why "presence in the queue," not "still the current pointer"

Ordinary navigation — `next()`, `prev()`, or auto-advance on `'ended'` —
moves `QueueManager`'s current-item pointer but does not remove the
previously-current item from the queue; it is simply no longer at the
pointer. Checking `queue.getItems().some(...)` for the loaded item's
presence therefore stays silent during normal playback progression, and
only fires when the item is actually removed (`queue.remove()`) or the
queue is emptied (`queue.clear()`) — exactly the two scenarios the final
review's repro cases covered.

### Why re-check inside the enqueued callback

Because the reconciliation job is itself serialized behind whatever
operation was in flight when the `'changed'` event fired, the situation may
have changed again by the time it actually runs (the item could have been
re-added, or another operation could have already moved playback on). The
re-check (`#loadedQueueItemId !== missingQueueItemId` /
re-scanning `queue.getItems()`) guards against acting on stale intent,
consistent with how every other operation in the chain treats its own
preconditions as re-checked-at-execution-time, not decided-at-enqueue-time.

### Behavior on removal: stop, don't auto-advance

When the currently-playing item is removed and `QueueManager`'s pointer
auto-adjusts to point at some other item (per its existing `remove()`
logic), `CorePlayer` does **not** automatically start playing whatever is
now current. It stops and returns to `'idle'`, leaving the decision to
resume to the host — consistent with the existing design principle that
Core does not make UX-policy calls on the host's behalf (the same
reasoning behind "no auto-skip on an unrecoverable error"). This is a
deliberate host-initiated mutation, not a natural end-of-track event, so
it is not treated like the `'ended'` auto-advance case.

## Testing

New test cases added to `test/CorePlayer.test.js`:

1. **Concurrent `next()` calls resolve in order.** `Promise.all([core.next(), core.next()])` on a 3-track queue ends deterministically on the third track — `engine.loaded` reflects it, and both `trackChanged` events fire in the correct order.
2. **`pause()` issued during an in-flight `play()` still ends up paused.** Call `core.play()` without awaiting, then `await core.pause()` — final status is `'paused'`, not `'playing'`.
3. **Removing the currently-playing item stops playback.** Play a track, then call `core.queue.remove(currentItem.queueItemId)` directly — `engine.stop()` is called and status becomes `'idle'`.
4. **Clearing the queue during playback stops playback.** Play a track, then call `core.queue.clear()` — same assertions as above.
5. **Reordering does not interrupt playback.** Play a track, then `core.queue.reorder(...)` without removing anything — status remains `'playing'`, no `engine.stop()` call.
6. **Normal navigation is unaffected by reconciliation.** Existing `next()`/`prev()`/auto-advance tests continue to pass unmodified, confirming reconciliation does not fight normal playback progression.

## Non-goals

Restated from Scope: `EventEmitter`/synchronous-plugin-exception hardening,
`restoreState()` semantics, and the missing `off()`/`dispose()` plugin
contract gap are all out of scope for this spec.
